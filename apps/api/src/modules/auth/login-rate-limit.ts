import { createHmac, randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { inTransaction } from "#api/db/transaction";
import { normalizeEmail } from "#api/modules/auth/email";
import { AuthRateLimitExceededError } from "#api/modules/auth/rate-limit";

type SubjectKind = "client_address" | "identifier_client_address";
type LoginPool = Pick<Pool, "connect">;
type LoginClient = Pick<PoolClient, "query">;
export interface PasswordLoginAttempt {
  subjectHash: string;
  windowId: string;
  attemptId: string;
  expiresAt: Date;
  completed?: boolean;
}
type AttemptOutcome = "success" | "failure" | "release";
interface LimitRow {
  windowId: string;
  expiresAt: Date;
  attemptCount: number;
  pendingAttempts: string[];
}

export const hashPasswordLoginSubject = (
  kind: SubjectKind,
  subjects: readonly string[],
  secret: string,
): string => {
  return createHmac("sha256", secret)
    .update(
      JSON.stringify(["amuq:password-login-limit:v1", kind, subjects]),
      "utf8",
    )
    .digest("hex");
};

export const consumePasswordLoginIp = async (
  pool: LoginPool,
  clientAddress: string,
  secret: string,
): Promise<void> => {
  const subjectHash = hashPasswordLoginSubject(
    "client_address",
    [clientAddress],
    secret,
  );
  await inTransaction(pool, async (client) => {
    const { row, now } = await lockAdmissionWindow(
      client,
      "client_address",
      subjectHash,
    );
    if (row.attemptCount >= 100) throw limitExceeded(row, now);
    await client.query(
      `UPDATE auth_password_login_limits SET attempt_count = attempt_count + 1 WHERE subject_kind = 'client_address' AND subject_hash = $1`,
      [subjectHash],
    );
    await client.query(
      `WITH expired AS (
      SELECT subject_kind, subject_hash FROM auth_password_login_limits
      WHERE expires_at <= $1 ORDER BY expires_at LIMIT 128 FOR UPDATE SKIP LOCKED
    ) DELETE FROM auth_password_login_limits AS limits USING expired
      WHERE limits.subject_kind = expired.subject_kind AND limits.subject_hash = expired.subject_hash`,
      [now],
    );
  });
};

export const reservePasswordLoginAttempt = async (
  pool: LoginPool,
  email: string,
  clientAddress: string,
  secret: string,
): Promise<PasswordLoginAttempt> => {
  const subjectHash = hashPasswordLoginSubject(
    "identifier_client_address",
    [normalizeEmail(email), clientAddress],
    secret,
  );
  return inTransaction(pool, async (client) => {
    const { row, now } = await lockAdmissionWindow(
      client,
      "identifier_client_address",
      subjectHash,
    );
    if (row.attemptCount + row.pendingAttempts.length >= 10)
      throw limitExceeded(row, now);
    const attemptId = randomUUID();
    await client.query(
      `UPDATE auth_password_login_limits SET pending_attempts = array_append(pending_attempts, $2::uuid)
      WHERE subject_kind = 'identifier_client_address' AND subject_hash = $1 AND NOT ($2::uuid = ANY(pending_attempts))`,
      [subjectHash, attemptId],
    );
    return {
      subjectHash,
      windowId: row.windowId,
      attemptId,
      expiresAt: row.expiresAt,
    };
  });
};

// Pass the authentication transaction's client for success so quota and session commit together.
export const finishPasswordLoginAttemptInTransaction = async (
  client: LoginClient,
  attempt: PasswordLoginAttempt,
  outcome: AttemptOutcome,
): Promise<void> => {
  const result = await client.query<LimitRow>(
    `SELECT window_id AS "windowId", expires_at AS "expiresAt", attempt_count AS "attemptCount", pending_attempts AS "pendingAttempts"
    FROM auth_password_login_limits WHERE subject_kind = 'identifier_client_address' AND subject_hash = $1 FOR UPDATE`,
    [attempt.subjectHash],
  );
  const now = await readDatabaseClock(client);
  const row = result.rows[0];
  if (!row || row.windowId !== attempt.windowId) {
    if (outcome === "success" && attempt.expiresAt > now)
      throw new Error("Password login reservation window is no longer owned");
    return;
  }
  if (row.expiresAt <= now) return;
  if (!row.pendingAttempts.includes(attempt.attemptId)) {
    if (outcome === "success")
      throw new Error("Password login reservation is no longer owned");
    return;
  }
  await client.query(
    `UPDATE auth_password_login_limits
    SET pending_attempts = array_remove(pending_attempts, $2::uuid),
        attempt_count = CASE WHEN $3 = 'success' THEN 0 WHEN $3 = 'failure' THEN attempt_count + 1 ELSE attempt_count END
    WHERE subject_kind = 'identifier_client_address' AND subject_hash = $1`,
    [attempt.subjectHash, attempt.attemptId, outcome],
  );
};

export const finishPasswordLoginAttempt = async (
  pool: LoginPool,
  attempt: PasswordLoginAttempt,
  outcome: AttemptOutcome,
): Promise<void> => {
  await inTransaction(pool, (client) =>
    finishPasswordLoginAttemptInTransaction(client, attempt, outcome),
  );
  attempt.completed = true;
};

export const withPasswordLoginAttempt = async <T>(
  pool: LoginPool,
  email: string,
  clientAddress: string,
  secret: string,
  authenticate: (attempt: PasswordLoginAttempt) => Promise<T>,
): Promise<T> => {
  const attempt = await reservePasswordLoginAttempt(
    pool,
    email,
    clientAddress,
    secret,
  );
  try {
    const result = await authenticate(attempt);
    if (!attempt.completed)
      await finishPasswordLoginAttempt(pool, attempt, "release");
    return result;
  } catch (error) {
    try {
      if (!attempt.completed)
        await finishPasswordLoginAttempt(pool, attempt, "release");
    } catch {
      // Preserve the authentication error; an orphan reservation expires with its window.
    }
    throw error;
  }
};

const lockAdmissionWindow = async (
  client: LoginClient,
  kind: SubjectKind,
  subjectHash: string,
) => {
  // The upsert obtains the row lock before reading actual time, including after a wait.
  const result = await client.query<LimitRow>(
    `INSERT INTO auth_password_login_limits
    (subject_kind, subject_hash, window_started_at, expires_at)
    VALUES ($1, $2, clock_timestamp(), clock_timestamp() + interval '15 minutes')
    ON CONFLICT (subject_kind, subject_hash) DO UPDATE SET subject_hash = EXCLUDED.subject_hash
    RETURNING window_id AS "windowId", expires_at AS "expiresAt", attempt_count AS "attemptCount", pending_attempts AS "pendingAttempts"`,
    [kind, subjectHash],
  );
  const now = await readDatabaseClock(client);
  let row = result.rows[0]!;
  if (row.expiresAt <= now) {
    const reset = await client.query<LimitRow>(
      `UPDATE auth_password_login_limits
      SET window_id = gen_random_uuid(), window_started_at = $3, expires_at = $3::timestamptz + interval '15 minutes', attempt_count = 0, pending_attempts = '{}'::uuid[]
      WHERE subject_kind = $1 AND subject_hash = $2
      RETURNING window_id AS "windowId", expires_at AS "expiresAt", attempt_count AS "attemptCount", pending_attempts AS "pendingAttempts"`,
      [kind, subjectHash, now],
    );
    row = reset.rows[0]!;
  }
  return { row, now };
};

const readDatabaseClock = async (client: LoginClient): Promise<Date> => {
  return (await client.query<{ now: Date }>("SELECT clock_timestamp() AS now"))
    .rows[0]!.now;
};

const limitExceeded = (row: LimitRow, now: Date) =>
  new AuthRateLimitExceededError(
    Math.max(1, Math.ceil((row.expiresAt.getTime() - now.getTime()) / 1000)),
  );
