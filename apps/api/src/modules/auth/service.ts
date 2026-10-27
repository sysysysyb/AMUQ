import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { inTransaction } from "#api/db/transaction";
import { normalizeEmail } from "#api/modules/auth/email";
import { type GoogleIdentity, safeReturnTo } from "#api/modules/auth/google";
import {
  finishPasswordLoginAttempt,
  finishPasswordLoginAttemptInTransaction,
  type PasswordLoginAttempt,
} from "#api/modules/auth/login-rate-limit";
import { hashPassword, verifyPassword } from "#api/modules/auth/password";
import {
  type AuthRateLimitResult,
  consumeAuthRateLimit,
} from "#api/modules/auth/rate-limit";
import {
  accountLinkSessionLifetimeMs,
  createPasswordResetSession,
  createSession,
  googleOidcFlowLifetimeMs,
} from "#api/modules/auth/session";
import { lockSignupEmail } from "#api/modules/auth/signup-challenge";
import {
  authTokenKeyId,
  type AuthTokenPurpose,
  createAuthToken,
  createOpaqueToken,
  hashOpaqueToken,
} from "#api/modules/auth/token";

type AuthDatabase = Pick<Pool, "query">;
type AuthPool = Pick<Pool, "connect" | "query">;
type AuthClock = Date | (() => Date);

export interface AuthenticatedUser {
  email: string;
  emailVerified: boolean;
  id: string;
}

export interface PasswordLogin {
  sessionToken: string;
  status: "authenticated";
  user: AuthenticatedUser;
}

export interface AccountLinkRequired {
  linkSessionToken: string;
  requiredProvider: "google" | "password";
  status: "account_link_required";
}

export interface AccountLinkStatus {
  email: string;
  requiredProvider: "google" | "password";
}

export interface AuthMutationOptions {
  authTokenSecret: string;
  rateLimitSecret: string;
}

const dummyPasswordHash =
  "$argon2id$v=19$m=65536,p=4,t=3$/XC+PQlPIdJDJWiXfvfvxw$+WzZ5j/X4/oxmsETwRwLGN+rxo1XEqjSG2fvDKrVBYA";

export interface IssuedAuthToken {
  id: string;
  rawToken: string;
}

export interface PasswordResetSession {
  expiresAt: Date;
  rawToken: string;
}

export interface GoogleOidcFlowStart {
  codeChallenge: string;
  flowToken: string;
  nonce: string;
  state: string;
}

export interface ConsumedGoogleOidcFlow {
  codeVerifier: string;
  mode: "link" | "login";
  nonceHash: string;
  returnTo: string;
  linkTokenHash: string | null;
  userId: string | null;
}

export type AuthenticationResult =
  | { sessionToken: string; status: "authenticated"; user: AuthenticatedUser }
  | AccountLinkRequired
  | {
      status: "identity_conflict" | "invalid_credentials" | "invalid_session";
    };

export type PasswordAuthenticationResult = AccountLinkRequired | PasswordLogin;

export const issueAuthToken = async (
  database: AuthDatabase,
  userId: string,
  purpose: AuthTokenPurpose,
  secret: string,
  now = new Date(),
): Promise<IssuedAuthToken> => {
  const token = createAuthToken(purpose, secret, now);
  const result = await database.query<{ id: string }>(
    `WITH token AS (
       INSERT INTO auth_tokens
         (id, user_id, purpose, token_hash, created_at, expires_at)
       SELECT $2, id, $3, $4, $5, $6
         FROM users
        WHERE id = $1
       RETURNING id
     ), outbox AS (
       INSERT INTO email_outbox (token_id, token_key_id, created_at, updated_at)
       SELECT id, $7, $5, $5
         FROM token
       RETURNING token_id
     )
     SELECT token_id::text AS "id" FROM outbox`,
    [
      userId,
      token.id,
      purpose,
      token.tokenHash,
      token.createdAt,
      token.expiresAt,
      authTokenKeyId(secret),
    ],
  );
  if (!result.rows[0]) throw new Error("Cannot issue auth token");
  return { id: result.rows[0].id, rawToken: token.rawToken };
};

export const consumeAuthToken = async (
  database: AuthDatabase,
  purpose: AuthTokenPurpose,
  rawToken: string,
  now = new Date(),
): Promise<string | undefined> => {
  const result = await database.query<{ userId: string }>(
    `UPDATE auth_tokens
       SET consumed_at = $3
     WHERE purpose = $1
       AND token_hash = $2
       AND consumed_at IS NULL
       AND expires_at > $3
     RETURNING user_id::text AS "userId"`,
    [purpose, hashOpaqueToken(rawToken), now],
  );
  return result.rows[0]?.userId;
};

export const issueSession = async (
  database: AuthDatabase,
  userId: string,
  now = new Date(),
): Promise<string | undefined> => {
  const session = createSession(now);
  const result = await database.query<{ userId: string }>(
    `INSERT INTO auth_sessions
      (user_id, token_hash, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
     SELECT id, $2, $3, $4, $5, $6
       FROM users
      WHERE id = $1
        AND email_verified_at IS NOT NULL
     RETURNING user_id::text AS "userId"`,
    [
      userId,
      session.tokenHash,
      session.createdAt,
      session.lastSeenAt,
      session.idleExpiresAt,
      session.absoluteExpiresAt,
    ],
  );
  return result.rows[0] ? session.rawToken : undefined;
};

export const authenticateSession = async (
  database: AuthDatabase,
  rawToken: string,
  now = new Date(),
): Promise<string | undefined> => {
  const result = await database.query<{ userId: string }>(
    `UPDATE auth_sessions
       SET last_seen_at = GREATEST(last_seen_at, $2),
           idle_expires_at = LEAST(
             GREATEST(last_seen_at, $2) + interval '7 days',
             absolute_expires_at
           )
     WHERE token_hash = $1
       AND revoked_at IS NULL
       AND idle_expires_at > $2
       AND absolute_expires_at > $2
     RETURNING user_id::text AS "userId"`,
    [hashOpaqueToken(rawToken), now],
  );
  return result.rows[0]?.userId;
};

export const revokeSession = async (
  database: AuthDatabase,
  rawToken: string,
  now = new Date(),
): Promise<void> => {
  await database.query(
    `UPDATE auth_sessions
        SET revoked_at = $2
      WHERE token_hash = $1
        AND revoked_at IS NULL`,
    [hashOpaqueToken(rawToken), now],
  );
};

export const rotateSession = async (
  database: AuthDatabase,
  rawToken: string,
  now = new Date(),
): Promise<string | undefined> => {
  return rotateSessionHash(database, hashOpaqueToken(rawToken), now);
};

const rotateSessionHash = async (
  database: AuthDatabase,
  tokenHash: string,
  now: Date,
): Promise<string | undefined> => {
  const replacement = createSession(now);
  const result = await database.query<{ userId: string }>(
    `WITH revoked AS (
       UPDATE auth_sessions
          SET revoked_at = $2
        WHERE token_hash = $1
          AND revoked_at IS NULL
          AND idle_expires_at > $2
          AND absolute_expires_at > $2
       RETURNING user_id, absolute_expires_at
     )
     INSERT INTO auth_sessions
       (user_id, token_hash, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
     SELECT user_id,
            $3,
            $2,
            $2,
            LEAST($2 + interval '7 days', absolute_expires_at),
            absolute_expires_at
       FROM revoked
     RETURNING user_id::text AS "userId"`,
    [tokenHash, now, replacement.tokenHash],
  );
  return result.rows[0] ? replacement.rawToken : undefined;
};

export const createGoogleLoginFlow = (
  database: AuthDatabase,
  returnTo: string | undefined,
  now = new Date(),
): Promise<GoogleOidcFlowStart> => {
  return insertGoogleOidcFlow(database, "login", null, null, returnTo, now);
};

export const consumeGoogleOidcFlow = async (
  database: AuthDatabase,
  rawFlowToken: string,
  rawState: string,
  rawLinkToken?: string,
  now = new Date(),
): Promise<ConsumedGoogleOidcFlow | undefined> => {
  const result = await database.query<
    Omit<ConsumedGoogleOidcFlow, "codeVerifier">
  >(
    `UPDATE auth_oidc_flows
        SET consumed_at = $3
      WHERE flow_hash = $1
        AND state_hash = $2
        AND (mode = 'login' OR session_token_hash = $4)
        AND consumed_at IS NULL
        AND expires_at > $3
    RETURNING mode,
              nonce_hash AS "nonceHash",
              return_to AS "returnTo",
              session_token_hash AS "linkTokenHash",
              user_id::text AS "userId"`,
    [
      hashOpaqueToken(rawFlowToken),
      hashOpaqueToken(rawState),
      now,
      rawLinkToken ? hashOpaqueToken(rawLinkToken) : null,
    ],
  );
  return result.rows[0]
    ? {
        ...result.rows[0],
        codeVerifier: rawFlowToken,
      }
    : undefined;
};

export const completeGoogleLogin = async (
  database: AuthPool,
  identity: GoogleIdentity,
  clock: AuthClock = () => new Date(),
): Promise<AuthenticationResult> => {
  const email = normalizeEmail(identity.email);
  return inTransaction(database, async (client) => {
    await lockGoogleIdentityChanges(client);
    await lockSignupEmail(client, email);
    const now = readAuthClock(clock);
    const existing = await client.query<{
      activatedAt: Date | null;
      email: string;
      emailVerified: boolean;
      id: string;
    }>(
      `SELECT users.id::text,
              users.email,
              users.email_verified_at IS NOT NULL AS "emailVerified",
              identity.activated_at AS "activatedAt"
         FROM auth_identities AS identity
         JOIN users ON users.id = identity.user_id
        WHERE identity.provider = 'google'
          AND identity.provider_subject = $1
        FOR UPDATE OF users, identity`,
      [identity.subject],
    );
    if (existing.rows[0]) {
      if (!existing.rows[0].activatedAt) {
        const required = await client.query(
          `SELECT 1
             FROM auth_identities
            WHERE user_id = $1
              AND provider = 'password'
              AND verified_at IS NOT NULL
              AND activated_at IS NOT NULL`,
          [existing.rows[0].id],
        );
        if (!required.rows[0]) return { status: "identity_conflict" };
        return {
          linkSessionToken: await issueAccountLinkSession(
            client,
            existing.rows[0].id,
            "google",
            "password",
            now,
          ),
          requiredProvider: "password",
          status: "account_link_required",
        };
      }
      const sessionToken = await issueSession(client, existing.rows[0].id, now);
      if (!sessionToken) return { status: "invalid_session" };
      return {
        sessionToken,
        status: "authenticated",
        user: {
          email: existing.rows[0].email,
          emailVerified: existing.rows[0].emailVerified,
          id: existing.rows[0].id,
        },
      };
    }

    const sameEmail = await client.query<{
      id: string;
      verifiedAt: Date | null;
    }>(
      'SELECT id::text, email_verified_at AS "verifiedAt" FROM users WHERE email = $1 FOR UPDATE',
      [email],
    );
    if (sameEmail.rows[0]) {
      const identities = await client.query<{
        activatedAt: Date | null;
        provider: "google" | "password";
        verifiedAt: Date | null;
      }>(
        `SELECT provider,
                verified_at AS "verifiedAt",
                activated_at AS "activatedAt"
           FROM auth_identities
          WHERE user_id = $1
          FOR UPDATE`,
        [sameEmail.rows[0].id],
      );
      if (
        isRecoverableLegacyPasswordAccount(
          sameEmail.rows[0].verifiedAt,
          identities.rows,
        )
      ) {
        const userId = sameEmail.rows[0].id;
        await retireLegacySignupCredentials(client, userId, now);
        await client.query(
          "DELETE FROM auth_identities WHERE user_id = $1 AND provider = 'password'",
          [userId],
        );
        await client.query(
          "UPDATE users SET email_verified_at = $2, updated_at = $2 WHERE id = $1",
          [userId, now],
        );
        await client.query(
          `INSERT INTO auth_identities (user_id, provider, provider_subject, verified_at, activated_at, created_at, updated_at)
           VALUES ($1, 'google', $2, $3, $3, $3, $3)`,
          [userId, identity.subject, now],
        );
        const sessionToken = await issueSession(client, userId, now);
        if (!sessionToken)
          throw new Error("Cannot issue recovered Google session");
        return {
          status: "authenticated",
          sessionToken,
          user: { id: userId, email, emailVerified: true },
        };
      }
      if (
        identities.rows.some(({ provider }) => provider === "google") ||
        !identities.rows.some(
          ({ activatedAt, provider, verifiedAt }) =>
            provider === "password" && activatedAt && verifiedAt,
        )
      ) {
        return { status: "identity_conflict" };
      }
      await client.query(
        `INSERT INTO auth_identities
           (user_id, provider, provider_subject, verified_at, created_at, updated_at)
         VALUES ($1, 'google', $2, $3, $3, $3)`,
        [sameEmail.rows[0].id, identity.subject, now],
      );
      return {
        linkSessionToken: await issueAccountLinkSession(
          client,
          sameEmail.rows[0].id,
          "google",
          "password",
          now,
        ),
        requiredProvider: "password",
        status: "account_link_required",
      };
    }

    const created = await client.query<{ email: string; id: string }>(
      `INSERT INTO users
         (email, email_verified_at, created_at, updated_at)
       VALUES ($1, $2, $2, $2)
       RETURNING id::text, email`,
      [email, now],
    );
    const user = created.rows[0]!;
    await client.query(
      `INSERT INTO auth_identities
         (user_id, provider, provider_subject, verified_at, activated_at, created_at, updated_at)
       VALUES ($1, 'google', $2, $3, $3, $3, $3)`,
      [user.id, identity.subject, now],
    );
    const sessionToken = await issueSession(client, user.id, now);
    if (!sessionToken) throw new Error("Cannot issue Google session");
    return {
      sessionToken,
      status: "authenticated",
      user: { ...user, emailVerified: true },
    };
  });
};

export const completeGoogleLink = async (
  database: AuthPool,
  flow: ConsumedGoogleOidcFlow,
  identity: GoogleIdentity,
  clock: AuthClock = () => new Date(),
): Promise<AuthenticationResult> => {
  if (flow.mode !== "link" || !flow.userId || !flow.linkTokenHash) {
    return { status: "invalid_session" };
  }
  const userId = flow.userId;
  const linkTokenHash = flow.linkTokenHash;
  return inTransaction(database, async (client) => {
    await lockGoogleIdentityChanges(client);
    const user = await client.query<{ email: string; id: string }>(
      "SELECT id::text, email FROM users WHERE id = $1 FOR UPDATE",
      [userId],
    );
    if (!user.rows[0]) return { status: "invalid_session" };
    const lockedAt = readAuthClock(clock);
    const link = await client.query<{ valid: boolean }>(
      `SELECT true AS valid
         FROM auth_link_sessions
        WHERE token_hash = $1
          AND user_id = $2
          AND primary_provider = 'password'
          AND required_provider = 'google'
          AND consumed_at IS NULL
          AND expires_at > $3
        FOR UPDATE`,
      [linkTokenHash, userId, lockedAt],
    );
    if (!link.rows[0]) return { status: "invalid_session" };

    const google = await client.query<{
      providerSubject: string;
    }>(
      `SELECT provider_subject AS "providerSubject"
         FROM auth_identities
        WHERE provider = 'google'
          AND user_id = $1
          AND verified_at IS NOT NULL
          AND activated_at IS NOT NULL
        FOR UPDATE`,
      [userId],
    );
    if (google.rows[0]?.providerSubject !== identity.subject) {
      return { status: "identity_conflict" };
    }
    const activated = await client.query(
      `UPDATE auth_identities
          SET activated_at = $2, updated_at = $2
        WHERE user_id = $1
          AND provider = 'password'
          AND verified_at IS NOT NULL
          AND activated_at IS NULL
      RETURNING id`,
      [userId, lockedAt],
    );
    if (!activated.rows[0]) return { status: "invalid_session" };
    if (
      !(await consumeAccountLinkSessions(
        client,
        userId,
        linkTokenHash,
        lockedAt,
      ))
    ) {
      return { status: "invalid_session" };
    }
    const sessionToken = await issueSession(client, userId, lockedAt);
    if (!sessionToken) throw new Error("Cannot issue linked session");
    return {
      sessionToken,
      status: "authenticated",
      user: { ...user.rows[0], emailVerified: true },
    };
  });
};

export type SignupCompletion =
  | {
      status:
        | "created"
        | "already_completed"
        | "account_exists"
        | "invalid_proof"
        | "expired";
    }
  | AccountLinkRequired;

export const retireLegacySignupTokens = async (
  database: AuthPool,
  now = new Date(),
): Promise<void> => {
  await database.query(
    `WITH retired AS (
       UPDATE auth_tokens SET consumed_at = $1
        WHERE purpose = 'email_verification' AND consumed_at IS NULL RETURNING id
     ) UPDATE email_outbox SET status = 'failed', last_error_code = 'legacy_signup_retired', updated_at = $1
        WHERE token_id IN (SELECT id FROM retired) AND status = 'pending' AND attempt_count = 0`,
    [now],
  );
};

export const completeSignup = async (
  database: AuthPool,
  rawProof: string,
  password: string,
  clock: AuthClock = () => new Date(),
  admission?: { clientAddress: string; rateLimitSecret: string },
): Promise<SignupCompletion> => {
  const proofHash = hashOpaqueToken(rawProof);
  const candidate = await database.query<{
    id: string;
    email: string;
    proof_expires_at: Date;
    proof_consumed_at: Date | null;
  }>(
    "SELECT id, email, proof_expires_at, proof_consumed_at FROM auth_signup_attempts WHERE proof_hash = $1",
    [proofHash],
  );
  const attempt = candidate.rows[0];
  if (!attempt) return { status: "invalid_proof" };
  if (attempt.proof_consumed_at) return { status: "already_completed" };
  if (attempt.proof_expires_at <= readAuthClock(clock))
    return { status: "expired" };
  if (admission)
    await consumeAuthRateLimit(
      database,
      "signup",
      `signup-complete:${admission.clientAddress}`,
      `signup-complete:${proofHash}`,
      admission.rateLimitSecret,
      readAuthClock(clock),
    );
  const passwordHash = await hashPassword(password);
  return inTransaction(database, async (client) => {
    await lockGoogleIdentityChanges(client);
    await lockSignupEmail(client, attempt.email);
    const user = await client.query<{ id: string; verifiedAt: Date | null }>(
      'SELECT id, email_verified_at AS "verifiedAt" FROM users WHERE email = $1 FOR UPDATE',
      [attempt.email],
    );
    const locked = await client.query<{
      proof_consumed_at: Date | null;
      proof_expires_at: Date;
    }>(
      "SELECT proof_consumed_at, proof_expires_at FROM auth_signup_attempts WHERE id = $1 AND proof_hash = $2 FOR UPDATE",
      [attempt.id, proofHash],
    );
    if (!locked.rows[0]) return { status: "invalid_proof" };
    if (locked.rows[0].proof_consumed_at)
      return { status: "already_completed" };
    const now = readAuthClock(clock);
    if (locked.rows[0].proof_expires_at <= now) return { status: "expired" };
    const existing = user.rows[0];
    const identities = existing
      ? (
          await client.query<{
            provider: string;
            verifiedAt: Date | null;
            activatedAt: Date | null;
          }>(
            'SELECT provider, verified_at AS "verifiedAt", activated_at AS "activatedAt" FROM auth_identities WHERE user_id = $1 FOR UPDATE',
            [existing.id],
          )
        ).rows
      : [];
    const isLegacy =
      existing &&
      isRecoverableLegacyPasswordAccount(existing.verifiedAt, identities);
    const isGoogleOnly =
      existing?.verifiedAt &&
      identities.length === 1 &&
      identities[0]!.provider === "google" &&
      identities[0]!.verifiedAt &&
      identities[0]!.activatedAt;
    let result: SignupCompletion;
    if (existing && !isLegacy && !isGoogleOnly) {
      result = { status: "account_exists" };
    } else {
      const userId =
        existing?.id ??
        (
          await client.query<{ id: string }>(
            "INSERT INTO users (email, email_verified_at, created_at, updated_at) VALUES ($1, $2, $2, $2) RETURNING id",
            [attempt.email, now],
          )
        ).rows[0]!.id;
      if (isLegacy) {
        await retireLegacySignupCredentials(client, userId, now);
        await client.query(
          "UPDATE users SET email_verified_at = $2, updated_at = $2 WHERE id = $1",
          [userId, now],
        );
        await client.query(
          "UPDATE auth_identities SET password_hash = $2, verified_at = $3, activated_at = $3, updated_at = $3 WHERE user_id = $1 AND provider = 'password'",
          [userId, passwordHash, now],
        );
      } else {
        await client.query(
          `INSERT INTO auth_identities (user_id, provider, password_hash, verified_at, activated_at, created_at, updated_at)
           VALUES ($1, 'password', $2, $3, $4, $3, $3)`,
          [userId, passwordHash, now, isGoogleOnly ? null : now],
        );
      }
      result = isGoogleOnly
        ? {
            status: "account_link_required",
            requiredProvider: "google",
            linkSessionToken: await issueAccountLinkSession(
              client,
              userId,
              "password",
              "google",
              now,
            ),
          }
        : { status: "created" };
    }
    await client.query(
      "UPDATE auth_signup_attempts SET proof_consumed_at = $2 WHERE id = $1",
      [attempt.id, now],
    );
    return result;
  });
};

const isRecoverableLegacyPasswordAccount = (
  verifiedAt: Date | null,
  identities: { provider: string; verifiedAt: Date | null }[],
): boolean =>
  !verifiedAt &&
  identities.length === 1 &&
  identities[0]!.provider === "password" &&
  !identities[0]!.verifiedAt;

const retireLegacySignupCredentials = async (
  client: PoolClient,
  userId: string,
  now: Date,
) => {
  await client.query(
    `WITH retired AS (
       UPDATE auth_tokens SET consumed_at = $2 WHERE user_id = $1 AND consumed_at IS NULL RETURNING id
     ) UPDATE email_outbox SET status = 'failed', last_error_code = 'legacy_signup_retired', updated_at = $2
       WHERE token_id IN (SELECT id FROM retired) AND status = 'pending' AND attempt_count = 0`,
    [userId, now],
  );
  await client.query(
    "UPDATE auth_sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL",
    [userId, now],
  );
  await client.query(
    "UPDATE auth_link_sessions SET consumed_at = $2 WHERE user_id = $1 AND consumed_at IS NULL",
    [userId, now],
  );
  await client.query(
    "UPDATE auth_oidc_flows SET consumed_at = $2 WHERE user_id = $1 AND consumed_at IS NULL",
    [userId, now],
  );
};

export const authenticatePassword = async (
  database: AuthPool,
  email: string,
  password: string,
  now = new Date(),
  attempt?: PasswordLoginAttempt,
): Promise<PasswordAuthenticationResult | undefined> => {
  const result = await database.query<{
    email: string;
    id: string;
    passwordHash: string;
    activatedAt: Date | null;
    verifiedAt: Date | null;
    hasActiveGoogle: boolean;
    emailVerified: boolean;
  }>(
    `SELECT users.id::text,
            users.email, users.email_verified_at IS NOT NULL AS "emailVerified",
            identity.password_hash AS "passwordHash"
            , identity.activated_at AS "activatedAt"
            , identity.verified_at AS "verifiedAt"
            , EXISTS (
                SELECT 1 FROM auth_identities AS google
                 WHERE google.user_id = users.id AND google.provider = 'google'
                   AND google.verified_at IS NOT NULL AND google.activated_at IS NOT NULL
              ) AS "hasActiveGoogle"
       FROM users
       JOIN auth_identities AS identity
         ON identity.user_id = users.id AND identity.provider = 'password'
      WHERE users.email = $1`,
    [normalizeEmail(email)],
  );
  const user = result.rows[0];
  const passwordValid = await verifyPassword(
    user?.passwordHash ?? dummyPasswordHash,
    password,
  );
  if (
    !user ||
    !user.emailVerified ||
    !user.verifiedAt ||
    !passwordValid ||
    (!user.activatedAt && !user.hasActiveGoogle)
  ) {
    if (attempt) await finishPasswordLoginAttempt(database, attempt, "failure");
    return undefined;
  }

  const login = await inTransaction<PasswordAuthenticationResult | undefined>(
    database,
    async (client) => {
      const locked = await client.query<{
        activatedAt: Date | null;
        email: string;
        id: string;
      }>(
        `SELECT users.id::text, users.email,
              identity.activated_at AS "activatedAt"
         FROM users
         JOIN auth_identities AS identity
           ON identity.user_id = users.id AND identity.provider = 'password'
        WHERE users.id = $1
          AND users.email_verified_at IS NOT NULL
          AND identity.verified_at IS NOT NULL
          AND identity.password_hash = $2
        FOR UPDATE OF users, identity`,
        [user.id, user.passwordHash],
      );
      if (!locked.rows[0]) return undefined;

      if (!locked.rows[0].activatedAt) {
        const required = await client.query(
          `SELECT 1
           FROM auth_identities
          WHERE user_id = $1
            AND provider = 'google'
            AND verified_at IS NOT NULL
            AND activated_at IS NOT NULL`,
          [locked.rows[0].id],
        );
        if (!required.rows[0]) return undefined;
        if (attempt)
          await finishPasswordLoginAttemptInTransaction(
            client,
            attempt,
            "success",
          );
        return {
          linkSessionToken: await issueAccountLinkSession(
            client,
            locked.rows[0].id,
            "password",
            "google",
            now,
          ),
          requiredProvider: "google",
          status: "account_link_required",
        };
      }

      if (attempt)
        await finishPasswordLoginAttemptInTransaction(
          client,
          attempt,
          "success",
        );
      const sessionToken = await issueSession(client, locked.rows[0].id, now);
      if (!sessionToken) throw new Error("Cannot issue password session");
      return {
        sessionToken,
        status: "authenticated" as const,
        user: {
          email: locked.rows[0].email,
          emailVerified: true,
          id: locked.rows[0].id,
        },
      };
    },
  );
  if (attempt && login) attempt.completed = true;
  return login;
};

export const getAuthenticatedUser = async (
  database: AuthPool,
  rawSessionToken: string,
  now = new Date(),
): Promise<AuthenticatedUser | undefined> => {
  const userId = await authenticateSession(database, rawSessionToken, now);
  if (!userId) return undefined;
  const result = await database.query<{
    email: string;
    emailVerified: boolean;
    id: string;
  }>(
    `SELECT id::text,
            email,
            email_verified_at IS NOT NULL AS "emailVerified"
       FROM users
      WHERE id = $1`,
    [userId],
  );
  return result.rows[0];
};

export const requestPasswordReset = async (
  database: AuthPool,
  email: string,
  clientAddress: string,
  options: AuthMutationOptions & { resend?: boolean },
  clock: AuthClock = () => new Date(),
): Promise<AuthRateLimitResult> => {
  const normalizedEmail = normalizeEmail(email);
  const rateLimit = await consumeAuthRateLimit(
    database,
    options.resend ? "password_reset_resend" : "password_reset",
    clientAddress,
    normalizedEmail,
    options.rateLimitSecret,
    readAuthClock(clock),
  );

  await inTransaction(database, async (client) => {
    const userId = await lockUserByEmail(client, normalizedEmail);
    const issuedAt = readAuthClock(clock);
    const token = createAuthToken(
      "password_reset",
      options.authTokenSecret,
      issuedAt,
    );
    await client.query(
      `WITH candidate AS MATERIALIZED (
         SELECT users.id
           FROM users
           JOIN auth_identities AS identity
             ON identity.user_id = users.id AND identity.provider = 'password'
          WHERE users.email = $1 AND users.id = $8 AND users.email_verified_at IS NOT NULL
       ), superseded AS (
         UPDATE auth_tokens
            SET consumed_at = $6
          WHERE user_id IN (SELECT id FROM candidate)
            AND purpose IN ('password_reset', 'password_reset_session')
            AND consumed_at IS NULL
            AND expires_at > $6
         RETURNING id
       ), failed AS (
         UPDATE email_outbox
            SET status = 'failed',
                last_error_code = 'superseded',
                updated_at = $6
          WHERE token_id IN (SELECT id FROM superseded)
            AND status = 'pending'
            AND attempt_count = 0
         RETURNING token_id
       ), inserted AS (
         INSERT INTO auth_tokens
           (id, user_id, purpose, token_hash, created_at, expires_at)
         SELECT $2, candidate.id, 'password_reset', $3, $4, $5
           FROM candidate
          WHERE (SELECT count(*) FROM failed) >= 0
         RETURNING id
       )
       INSERT INTO email_outbox (token_id, token_key_id, created_at, updated_at)
       SELECT id, $7, $4, $4 FROM inserted`,
      [
        normalizedEmail,
        token.id,
        token.tokenHash,
        token.createdAt,
        token.expiresAt,
        issuedAt,
        authTokenKeyId(options.authTokenSecret),
        userId,
      ],
    );
  });
  return rateLimit;
};

export const exchangePasswordResetToken = async (
  database: AuthPool,
  rawToken: string,
  clock: () => Date = () => new Date(),
): Promise<PasswordResetSession | undefined> => {
  const tokenHash = hashOpaqueToken(rawToken);
  const checkedAt = clock();
  const candidate = await database.query<{ userId: string }>(
    `SELECT user_id::text AS "userId"
       FROM auth_tokens
      WHERE purpose = 'password_reset'
        AND token_hash = $1
        AND consumed_at IS NULL
        AND expires_at > $2`,
    [tokenHash, checkedAt],
  );
  if (!candidate.rows[0]) return undefined;

  return inTransaction(database, async (client) => {
    await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [
      candidate.rows[0]!.userId,
    ]);
    const exchangedAt = clock();
    const consumed = await client.query<{ userId: string }>(
      `UPDATE auth_tokens
          SET consumed_at = $3
        WHERE purpose = 'password_reset'
          AND token_hash = $2
          AND user_id = $1
          AND consumed_at IS NULL
          AND expires_at > $3
      RETURNING user_id::text AS "userId"`,
      [candidate.rows[0]!.userId, tokenHash, exchangedAt],
    );
    if (!consumed.rows[0]) return undefined;

    const session = createPasswordResetSession(exchangedAt);
    await client.query(
      `INSERT INTO auth_tokens
         (user_id, purpose, token_hash, created_at, expires_at)
       VALUES ($1, 'password_reset_session', $2, $3, $4)`,
      [
        consumed.rows[0].userId,
        session.tokenHash,
        session.createdAt,
        session.expiresAt,
      ],
    );
    return { expiresAt: session.expiresAt, rawToken: session.rawToken };
  });
};

export const resetPassword = async (
  database: AuthPool,
  rawResetSessionToken: string,
  password: string,
  clock: () => Date = () => new Date(),
): Promise<boolean> => {
  const tokenHash = hashOpaqueToken(rawResetSessionToken);
  const checkedAt = clock();
  const candidate = await database.query<{ userId: string }>(
    `SELECT user_id::text AS "userId"
       FROM auth_tokens
      WHERE purpose = 'password_reset_session'
        AND token_hash = $1
        AND consumed_at IS NULL
        AND expires_at > $2`,
    [tokenHash, checkedAt],
  );
  if (!candidate.rows[0]) return false;

  const passwordHash = await hashPassword(password);
  return inTransaction(database, async (client) => {
    await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [
      candidate.rows[0]!.userId,
    ]);
    const updatedAt = clock();
    const token = await client.query<{ userId: string }>(
      `UPDATE auth_tokens
          SET consumed_at = $3
        WHERE purpose = 'password_reset_session'
          AND token_hash = $2
          AND user_id = $1
          AND consumed_at IS NULL
          AND expires_at > $3
      RETURNING user_id::text AS "userId"`,
      [candidate.rows[0]!.userId, tokenHash, updatedAt],
    );
    if (!token.rows[0]) return false;

    await client.query(
      `UPDATE auth_identities
          SET password_hash = $2, updated_at = $3
        WHERE user_id = $1 AND provider = 'password'`,
      [token.rows[0].userId, passwordHash, updatedAt],
    );
    await client.query(
      `UPDATE auth_sessions
          SET revoked_at = $2
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [token.rows[0].userId, updatedAt],
    );
    return true;
  });
};

const insertGoogleOidcFlow = async (
  database: AuthDatabase,
  mode: "link" | "login",
  userId: string | null,
  sessionTokenHash: string | null,
  returnTo: string | undefined,
  now: Date,
): Promise<GoogleOidcFlowStart> => {
  const flowToken = createOpaqueToken();
  const state = createOpaqueToken();
  const nonce = createOpaqueToken();
  await database.query(
    `WITH expired AS (
       DELETE FROM auth_oidc_flows WHERE expires_at <= $8
     )
     INSERT INTO auth_oidc_flows
       (flow_hash, state_hash, nonce_hash, mode, user_id,
        session_token_hash, return_to, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      hashOpaqueToken(flowToken),
      hashOpaqueToken(state),
      hashOpaqueToken(nonce),
      mode,
      userId,
      sessionTokenHash,
      safeReturnTo(returnTo),
      now,
      new Date(now.getTime() + googleOidcFlowLifetimeMs),
    ],
  );
  return {
    codeChallenge: createHash("sha256")
      .update(flowToken, "utf8")
      .digest("base64url"),
    flowToken,
    nonce,
    state,
  };
};

const issueAccountLinkSession = async (
  database: AuthDatabase,
  userId: string,
  primaryProvider: "google" | "password",
  requiredProvider: "google" | "password",
  now: Date,
): Promise<string> => {
  const rawToken = createOpaqueToken();
  await database.query(
    `WITH expired AS (
       DELETE FROM auth_link_sessions WHERE expires_at <= $5
     )
     INSERT INTO auth_link_sessions
       (token_hash, user_id, primary_provider, required_provider, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      hashOpaqueToken(rawToken),
      userId,
      primaryProvider,
      requiredProvider,
      now,
      new Date(now.getTime() + accountLinkSessionLifetimeMs),
    ],
  );
  return rawToken;
};

const consumeAccountLinkSessions = async (
  database: AuthDatabase,
  userId: string,
  linkTokenHash: string,
  now: Date,
): Promise<boolean> => {
  const result = await database.query(
    `UPDATE auth_link_sessions
        SET consumed_at = $3
      WHERE user_id = $1
        AND consumed_at IS NULL
        AND EXISTS (
          SELECT 1
            FROM auth_link_sessions AS current
           WHERE current.user_id = $1
             AND current.token_hash = $2
             AND current.consumed_at IS NULL
             AND current.expires_at > $3
        )
    RETURNING id`,
    [userId, linkTokenHash, now],
  );
  return Boolean(result.rows[0]);
};

const readAuthClock = (clock: AuthClock): Date => {
  return clock instanceof Date ? clock : clock();
};

const lockUserByEmail = async (
  client: PoolClient,
  email: string,
): Promise<string | null> => {
  const result = await client.query<{ id: string }>(
    "SELECT id FROM users WHERE email = $1 FOR UPDATE",
    [email],
  );
  return result.rows[0]?.id ?? null;
};

const lockGoogleIdentityChanges = async (database: AuthDatabase) => {
  // ponytail: one lock keeps account linking deadlock-free; split by subject only if OIDC completion throughput matters.
  await database.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('amuq:google-identity', 0))",
  );
};
