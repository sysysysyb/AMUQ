import { randomUUID, timingSafeEqual } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { inTransaction } from "#api/db/transaction";
import { normalizeEmail } from "#api/modules/auth/email";
import {
  AuthRateLimitExceededError,
  consumeAuthRateLimitInTransaction,
  hashRateLimitSubject,
} from "#api/modules/auth/rate-limit";
import {
  deriveSignupAttemptToken,
  deriveSignupCode,
  deriveSignupProof,
  digestSignupCode,
} from "#api/modules/auth/signup-token";
import {
  authTokenKeyId,
  authTokenSecretFor,
  hashOpaqueToken,
} from "#api/modules/auth/token";

type SignupPool = Pick<Pool, "connect" | "query">;
interface SignupOptions {
  authTokenSecret: string;
  authTokenPreviousSecret?: string;
  rateLimitSecret: string;
}
interface Attempt {
  id: string;
  email: string;
  token_hash: string;
  token_key_id: string;
  proof_hash: string | null;
  proof_key_id: string | null;
  proof_issued_at: Date | null;
  proof_expires_at: Date | null;
  proof_consumed_at: Date | null;
}
interface Code {
  id: string;
  attempt_id: string;
  recipient: string;
  operation_kind: "start" | "resend";
  token_key_id: string;
  code_digest: string;
  created_at: Date;
  expires_at: Date;
  resend_available_at: Date;
  revoked_at: Date | null;
  verified_at: Date | null;
  wrong_attempts: number;
}
export interface SignupChallenge {
  attemptToken: string;
  codeExpiresAt: Date;
  resendAvailableAt: Date;
}
export type SignupVerification =
  | { status: "verified"; signupProof: string; proofExpiresAt: Date }
  | { status: "invalid_code"; remainingAttempts: number }
  | {
      status:
        | "expired"
        | "attempts_exhausted"
        | "invalid_challenge"
        | "already_completed";
    };

export const lockSignupEmail = async (
  client: Pick<PoolClient, "query">,
  email: string,
): Promise<void> => {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `amuq:signup-email:${email}`,
  ]);
};

export class SignupChallengeExpiredError extends Error {
  constructor() {
    super("Signup challenge expired");
  }
}

export class SignupRequestError extends Error {}

const challengeResult = (
  attempt: Attempt,
  code: Code,
  options: SignupOptions,
  incomingToken?: string,
): SignupChallenge => {
  const secret = authTokenSecretFor(attempt.token_key_id, options);
  if (!incomingToken && !secret) throw new SignupChallengeExpiredError();
  return {
    attemptToken:
      incomingToken ?? deriveSignupAttemptToken(attempt.id, secret!),
    codeExpiresAt: code.expires_at,
    resendAvailableAt: code.resend_available_at,
  };
};

export const issueSignupChallenge = async (
  pool: SignupPool,
  email: string,
  operationKey: string,
  clientAddress: string,
  options: SignupOptions,
  clock: () => Date = () => new Date(),
): Promise<SignupChallenge> =>
  issueCode(
    pool,
    normalizeEmail(email),
    null,
    operationKey,
    clientAddress,
    options,
    clock,
  );

export const resendSignupChallenge = async (
  pool: SignupPool,
  attemptToken: string,
  operationKey: string,
  clientAddress: string,
  options: SignupOptions,
  clock: () => Date = () => new Date(),
): Promise<SignupChallenge> => {
  const found = await pool.query<Attempt>(
    "SELECT * FROM auth_signup_attempts WHERE token_hash = $1",
    [hashOpaqueToken(attemptToken)],
  );
  if (!found.rows[0]) throw new SignupRequestError("Invalid signup challenge");
  return issueCode(
    pool,
    found.rows[0].email,
    { id: found.rows[0].id, token: attemptToken },
    operationKey,
    clientAddress,
    options,
    clock,
  );
};

const issueCode = async (
  pool: SignupPool,
  email: string,
  request: { id: string; token: string } | null,
  operationKey: string,
  clientAddress: string,
  options: SignupOptions,
  clock: () => Date,
): Promise<SignupChallenge> => {
  const attemptId = request?.id ?? null;
  if (!/^[0-9a-f-]{36}$/i.test(operationKey))
    throw new SignupRequestError("Invalid operation key");
  const operationHash = hashOpaqueToken(
    `amuq:signup-operation:${operationKey}`,
  );
  const outcome = await inTransaction(
    pool,
    async (
      client,
    ): Promise<{ challenge: SignupChallenge } | { error: unknown }> => {
      // A key reused with another email must serialize before the per-email lock.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`amuq:signup-operation:${operationHash}`],
      );
      await lockSignupEmail(client, email);
      let issuedAt = clock();
      const replay = await client.query<Code>(
        "SELECT * FROM auth_signup_codes WHERE operation_hash = $1",
        [operationHash],
      );
      if (replay.rows[0]) {
        const code = replay.rows[0];
        if (
          code.recipient !== email ||
          code.operation_kind !== (attemptId ? "resend" : "start") ||
          (attemptId && code.attempt_id !== attemptId)
        )
          throw new SignupRequestError("Operation key conflict");
        const attempt = await client.query<Attempt>(
          "SELECT * FROM auth_signup_attempts WHERE id = $1",
          [code.attempt_id],
        );
        return {
          challenge: challengeResult(
            attempt.rows[0]!,
            code,
            options,
            request?.token,
          ),
        };
      }
      let currentAttempt: Attempt | undefined;
      if (attemptId) {
        const found = await client.query<Attempt>(
          "SELECT * FROM auth_signup_attempts WHERE id = $1 FOR UPDATE",
          [attemptId],
        );
        currentAttempt = found.rows[0];
        issuedAt = clock();
        if (!currentAttempt || currentAttempt.email !== email)
          throw new SignupRequestError("Invalid signup challenge");
        if (currentAttempt.proof_consumed_at)
          throw new SignupRequestError("Signup already completed");
        if (
          currentAttempt.proof_expires_at &&
          currentAttempt.proof_expires_at > issuedAt
        )
          throw new SignupRequestError("Signup already verified");
      }
      const latest = await client.query<{ created_at: Date }>(
        "SELECT created_at FROM auth_signup_codes WHERE recipient = $1 ORDER BY created_at DESC LIMIT 1",
        [email],
      );
      const lastIssuedAt = latest.rows[0]?.created_at;
      const activeResend = await client.query<{ expires_at: Date }>(
        `SELECT expires_at FROM auth_rate_limits
      WHERE scope = 'verification_resend' AND subject_kind = 'identifier' AND subject_hash = $1 AND expires_at > $2`,
        [
          hashRateLimitSubject("identifier", email, options.rateLimitSecret),
          issuedAt,
        ],
      );
      const isResend = Boolean(
        attemptId ||
        (lastIssuedAt &&
          lastIssuedAt.getTime() + 3_600_000 > issuedAt.getTime()) ||
        activeResend.rows.length,
      );
      const cooldown = lastIssuedAt ? lastIssuedAt.getTime() + 60_000 : 0;
      await client.query("SAVEPOINT admission");
      let retryAfterSeconds = Math.max(
        0,
        Math.ceil((cooldown - issuedAt.getTime()) / 1_000),
      );
      let nextAllowedSeconds = 60;
      for (const scope of (isResend
        ? ["signup", "verification_resend"]
        : ["signup"]) as ("signup" | "verification_resend")[]) {
        try {
          const budget = await consumeAuthRateLimitInTransaction(
            client,
            scope,
            clientAddress,
            email,
            options.rateLimitSecret,
            issuedAt,
          );
          if (budget.remaining === 0)
            nextAllowedSeconds = Math.max(
              nextAllowedSeconds,
              budget.retryAfterSeconds,
            );
        } catch (error) {
          if (!(error instanceof AuthRateLimitExceededError)) throw error;
          retryAfterSeconds = Math.max(
            retryAfterSeconds,
            error.retryAfterSeconds,
          );
        }
      }
      if (retryAfterSeconds) {
        await client.query("ROLLBACK TO SAVEPOINT admission");
        return { error: new AuthRateLimitExceededError(retryAfterSeconds) };
      }
      await client.query("SAVEPOINT issuance");
      try {
        let attempt: Attempt;
        if (currentAttempt) {
          attempt = currentAttempt;
        } else {
          const id = randomUUID();
          const inserted = await client.query<Attempt>(
            `INSERT INTO auth_signup_attempts (id, email, token_hash, token_key_id, created_at, email_subject_hash, last_issued_at)
          VALUES ($1, $2, $3, $4, $5, $6, $5) RETURNING *`,
            [
              id,
              email,
              hashOpaqueToken(
                deriveSignupAttemptToken(id, options.authTokenSecret),
              ),
              authTokenKeyId(options.authTokenSecret),
              issuedAt,
              hashRateLimitSubject(
                "identifier",
                email,
                options.rateLimitSecret,
              ),
            ],
          );
          attempt = inserted.rows[0]!;
        }
        await client.query(
          `UPDATE auth_signup_codes SET revoked_at = $2 WHERE recipient = $1 AND revoked_at IS NULL AND verified_at IS NULL`,
          [email, issuedAt],
        );
        await client.query(
          `UPDATE email_outbox outbox SET status = 'failed', last_error_code = 'token_consumed', updated_at = $2
        FROM auth_signup_codes code WHERE code.id = outbox.signup_code_id AND code.recipient = $1 AND code.revoked_at IS NOT NULL AND outbox.status = 'pending' AND outbox.attempt_count = 0`,
          [email, issuedAt],
        );
        const id = randomUUID();
        const code = deriveSignupCode(id, options.authTokenSecret);
        const expiresAt = new Date(issuedAt.getTime() + 600_000);
        const inserted = await client.query<Code>(
          `INSERT INTO auth_signup_codes (id, attempt_id, recipient, operation_hash, operation_kind, code_digest, token_key_id, created_at, expires_at, resend_available_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
          [
            id,
            attempt.id,
            email,
            operationHash,
            attemptId ? "resend" : "start",
            digestSignupCode(id, code, options.authTokenSecret),
            authTokenKeyId(options.authTokenSecret),
            issuedAt,
            expiresAt,
            new Date(issuedAt.getTime() + nextAllowedSeconds * 1_000),
          ],
        );
        await client.query(
          `INSERT INTO email_outbox (source_kind, signup_code_id, token_key_id, created_at, updated_at) VALUES ('signup_code', $1, $2, $3, $3)`,
          [id, authTokenKeyId(options.authTokenSecret), issuedAt],
        );
        if (currentAttempt)
          await client.query(
            "UPDATE auth_signup_attempts SET last_issued_at = $2 WHERE id = $1",
            [attempt.id, issuedAt],
          );
        return {
          challenge: challengeResult(
            attempt,
            inserted.rows[0]!,
            options,
            request?.token,
          ),
        };
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT issuance");
        return { error };
      }
    },
  );
  if ("error" in outcome) throw outcome.error;
  return outcome.challenge;
};

export const verifySignupChallenge = async (
  pool: SignupPool,
  attemptToken: string,
  input: string,
  options: SignupOptions,
  clock: () => Date = () => new Date(),
): Promise<SignupVerification> => {
  const checkedAt = clock();
  const found = await pool.query<Attempt>(
    "SELECT * FROM auth_signup_attempts WHERE token_hash = $1",
    [hashOpaqueToken(attemptToken)],
  );
  if (!found.rows[0]) return { status: "invalid_challenge" };
  const candidate = found.rows[0];
  return inTransaction(pool, async (client) => {
    await lockSignupEmail(client, candidate.email);
    const locked = await client.query<Attempt>(
      "SELECT * FROM auth_signup_attempts WHERE id = $1 FOR UPDATE",
      [candidate.id],
    );
    const attempt = locked.rows[0];
    if (!attempt) return { status: "invalid_challenge" };
    const codes = await client.query<Code>(
      "SELECT * FROM auth_signup_codes WHERE attempt_id = $1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
      [attempt.id],
    );
    const code = codes.rows[0];
    const verifiedAt = clock();
    if (!code || code.revoked_at) return { status: "invalid_challenge" };
    if (attempt.proof_consumed_at) return { status: "already_completed" };
    if (code.wrong_attempts >= 5) return { status: "attempts_exhausted" };
    const isReplay = Boolean(
      code.verified_at &&
      attempt.proof_issued_at?.getTime() === code.verified_at.getTime(),
    );
    if (
      isReplay
        ? !attempt.proof_expires_at || attempt.proof_expires_at <= verifiedAt
        : code.expires_at <= checkedAt || code.expires_at <= verifiedAt
    )
      return { status: "expired" };
    const secret = authTokenSecretFor(code.token_key_id, options);
    if (!secret) return { status: "expired" };
    const valid =
      /^\d{6}$/.test(input) &&
      timingSafeEqual(
        Buffer.from(digestSignupCode(code.id, input, secret), "hex"),
        Buffer.from(code.code_digest, "hex"),
      );
    if (!valid) {
      const attempts = code.wrong_attempts + 1;
      await client.query(
        "UPDATE auth_signup_codes SET wrong_attempts = $2 WHERE id = $1",
        [code.id, attempts],
      );
      return attempts === 5
        ? { status: "attempts_exhausted" }
        : { status: "invalid_code", remainingAttempts: 5 - attempts };
    }
    if (isReplay) {
      const proofSecret = authTokenSecretFor(attempt.proof_key_id, options);
      if (!proofSecret) return { status: "expired" };
      return {
        status: "verified",
        signupProof: deriveSignupProof(attempt.id, code.id, proofSecret),
        proofExpiresAt: attempt.proof_expires_at!,
      };
    }
    const signupProof = deriveSignupProof(
      attempt.id,
      code.id,
      options.authTokenSecret,
    );
    const proofExpiresAt = new Date(verifiedAt.getTime() + 1_800_000);
    await client.query(
      "UPDATE auth_signup_codes SET verified_at = $2 WHERE id = $1",
      [code.id, verifiedAt],
    );
    await client.query(
      `UPDATE auth_signup_attempts SET proof_hash = $2, proof_key_id = $3, proof_issued_at = $4, proof_expires_at = $5 WHERE id = $1`,
      [
        attempt.id,
        hashOpaqueToken(signupProof),
        authTokenKeyId(options.authTokenSecret),
        verifiedAt,
        proofExpiresAt,
      ],
    );
    return { status: "verified", signupProof, proofExpiresAt };
  });
};

export const cleanupSignupChallenges = async (
  database: {
    executeSql(sql: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  },
  now: Date,
): Promise<number> => {
  await database.executeSql(`WITH finished AS (
    SELECT outbox.id FROM email_outbox outbox
     WHERE outbox.source_kind = 'signup_code' AND outbox.status <> 'pending'
       AND (outbox.payload_hash IS NOT NULL OR outbox.token_key_id IS NOT NULL)
     ORDER BY outbox.created_at, outbox.id FOR UPDATE OF outbox SKIP LOCKED LIMIT 25
  ) UPDATE email_outbox outbox SET payload_hash = NULL, token_key_id = NULL
    FROM finished WHERE outbox.id = finished.id RETURNING outbox.id`);
  const result = await database.executeSql(
    `WITH expired AS (
    SELECT attempt.id FROM auth_signup_attempts attempt
    WHERE attempt.last_issued_at <= $1::timestamptz - interval '1 hour'
      AND (attempt.proof_expires_at IS NULL OR attempt.proof_expires_at <= $1)
      AND NOT EXISTS (SELECT 1 FROM auth_signup_codes code WHERE code.attempt_id = attempt.id AND code.created_at > $1::timestamptz - interval '1 hour')
      AND NOT EXISTS (SELECT 1 FROM auth_signup_codes code JOIN email_outbox outbox ON outbox.signup_code_id = code.id WHERE code.attempt_id = attempt.id AND outbox.status = 'pending')
      AND NOT EXISTS (SELECT 1 FROM auth_signup_codes code JOIN email_outbox outbox ON outbox.signup_code_id = code.id WHERE code.attempt_id = attempt.id AND (outbox.payload_hash IS NOT NULL OR outbox.token_key_id IS NOT NULL))
      AND NOT EXISTS (SELECT 1 FROM auth_rate_limits budget WHERE budget.scope IN ('signup', 'verification_resend') AND budget.subject_kind = 'identifier' AND budget.subject_hash = attempt.email_subject_hash AND budget.expires_at > $1)
    ORDER BY attempt.last_issued_at, attempt.id FOR UPDATE OF attempt SKIP LOCKED LIMIT 25
  ) DELETE FROM auth_signup_attempts attempt USING expired WHERE attempt.id = expired.id RETURNING attempt.id`,
    [now],
  );
  await database.executeSql(`WITH retired AS (
    SELECT outbox.id FROM email_outbox outbox
     WHERE outbox.source_kind = 'signup_code' AND outbox.signup_code_id IS NULL
       AND outbox.status <> 'pending' AND outbox.provider_message_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM email_webhook_events event WHERE event.outbox_id = outbox.id)
     ORDER BY outbox.created_at, outbox.id FOR UPDATE OF outbox SKIP LOCKED LIMIT 25
  ) DELETE FROM email_outbox outbox USING retired WHERE outbox.id = retired.id RETURNING outbox.id`);
  return result.rows.length;
};
