import type { Pool } from "pg";
import { createSession } from "#api/modules/auth/session";
import {
  authTokenKeyId,
  type AuthTokenPurpose,
  createAuthToken,
  hashOpaqueToken,
} from "#api/modules/auth/token";

type AuthDatabase = Pick<Pool, "query">;

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
