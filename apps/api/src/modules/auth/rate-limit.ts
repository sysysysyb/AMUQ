import { createHmac } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { inTransaction } from "#api/db/transaction";

export type AuthRateLimitScope =
  "signup" | "verification_resend" | "password_reset" | "password_reset_resend";
export type AuthRateLimitSubjectKind = "client_address" | "identifier";
export interface AuthRateLimitResult {
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

const policies: Record<
  AuthRateLimitScope,
  { limit: number; windowMilliseconds: number }
> = {
  signup: { limit: 5, windowMilliseconds: 60 * 60 * 1_000 },
  verification_resend: { limit: 3, windowMilliseconds: 60 * 60 * 1_000 },
  password_reset: { limit: 3, windowMilliseconds: 60 * 60 * 1_000 },
  password_reset_resend: { limit: 3, windowMilliseconds: 60 * 60 * 1_000 },
};

export class AuthRateLimitExceededError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("Authentication request rate limit exceeded");
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export const hashRateLimitSubject = (
  kind: AuthRateLimitSubjectKind,
  subject: string,
  secret: string,
): string => {
  return createHmac("sha256", secret)
    .update(`amuq:auth-rate-limit:${kind}:${subject}`, "utf8")
    .digest("hex");
};

export const consumeAuthRateLimit = async (
  pool: Pick<Pool, "connect">,
  scope: AuthRateLimitScope,
  clientAddress: string,
  normalizedIdentifier: string,
  secret: string,
  now = new Date(),
): Promise<AuthRateLimitResult> => {
  return inTransaction(pool, (client) =>
    consumeAuthRateLimitInTransaction(
      client,
      scope,
      clientAddress,
      normalizedIdentifier,
      secret,
      now,
    ),
  );
};

export const consumeAuthRateLimitInTransaction = async (
  client: Pick<PoolClient, "query">,
  scope: AuthRateLimitScope,
  clientAddress: string,
  normalizedIdentifier: string,
  secret: string,
  now: Date,
): Promise<AuthRateLimitResult> => {
  const policy = policies[scope];
  const subjects: { remaining: number; expiresAt: Date }[] = [];
  let retryAfterSeconds = 0;
  await client.query("DELETE FROM auth_rate_limits WHERE expires_at <= $1", [
    now,
  ]);

  for (const [kind, subject] of [
    ["client_address", clientAddress],
    ["identifier", normalizedIdentifier],
  ] as const) {
    try {
      subjects.push(
        await consumeSubject(
          client,
          scope,
          kind,
          hashRateLimitSubject(kind, subject, secret),
          policy.limit,
          policy.windowMilliseconds,
          now,
        ),
      );
    } catch (error) {
      if (!(error instanceof AuthRateLimitExceededError)) throw error;
      retryAfterSeconds = Math.max(retryAfterSeconds, error.retryAfterSeconds);
    }
  }
  if (retryAfterSeconds)
    throw new AuthRateLimitExceededError(retryAfterSeconds);
  const remaining = Math.min(...subjects.map((subject) => subject.remaining));
  return {
    limit: policy.limit,
    remaining,
    retryAfterSeconds: Math.max(
      1,
      ...subjects
        .filter((subject) => subject.remaining === remaining)
        .map((subject) =>
          Math.ceil((subject.expiresAt.getTime() - now.getTime()) / 1_000),
        ),
    ),
  };
};

const consumeSubject = async (
  client: Pick<PoolClient, "query">,
  scope: AuthRateLimitScope,
  kind: AuthRateLimitSubjectKind,
  subjectHash: string,
  limit: number,
  windowMilliseconds: number,
  now: Date,
): Promise<{ remaining: number; expiresAt: Date }> => {
  const expiresAt = new Date(now.getTime() + windowMilliseconds);
  const result = await client.query<{ expiresAt: Date; attemptCount: number }>(
    `INSERT INTO auth_rate_limits
       (scope, subject_kind, subject_hash, window_started_at, expires_at, attempt_count)
     VALUES ($1, $2, $3, $4, $5, 1)
     ON CONFLICT (scope, subject_kind, subject_hash) DO UPDATE
       SET attempt_count = auth_rate_limits.attempt_count + 1
       WHERE auth_rate_limits.attempt_count < $6
     RETURNING expires_at AS "expiresAt", attempt_count AS "attemptCount"`,
    [scope, kind, subjectHash, now, expiresAt, limit],
  );
  if (result.rows[0])
    return {
      remaining: limit - result.rows[0].attemptCount,
      expiresAt: result.rows[0].expiresAt,
    };

  const blocked = await client.query<{ expiresAt: Date }>(
    `SELECT expires_at AS "expiresAt"
       FROM auth_rate_limits
      WHERE scope = $1 AND subject_kind = $2 AND subject_hash = $3`,
    [scope, kind, subjectHash],
  );
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((blocked.rows[0]!.expiresAt.getTime() - now.getTime()) / 1_000),
  );
  throw new AuthRateLimitExceededError(retryAfterSeconds);
};
