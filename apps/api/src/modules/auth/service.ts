import type { Pool, PoolClient } from "pg";
import { inTransaction } from "#api/db/transaction";
import { normalizeEmail } from "#api/modules/auth/email";
import {
  finishPasswordLoginAttempt,
  finishPasswordLoginAttemptInTransaction,
  type PasswordLoginAttempt,
} from "#api/modules/auth/login-rate-limit";
import { hashPassword, verifyPassword } from "#api/modules/auth/password";
import { consumeAuthRateLimit } from "#api/modules/auth/rate-limit";
import {
  accountLinkSessionLifetimeMs,
  createSession,
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

const readAuthClock = (clock: AuthClock): Date => {
  return clock instanceof Date ? clock : clock();
};

const lockGoogleIdentityChanges = async (database: AuthDatabase) => {
  // ponytail: one lock keeps account linking deadlock-free; split by subject only if OIDC completion throughput matters.
  await database.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('amuq:google-identity', 0))",
  );
};
