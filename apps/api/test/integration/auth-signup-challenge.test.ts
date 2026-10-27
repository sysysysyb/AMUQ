import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { expect, it, vi } from "vitest";

import { migrateDatabase } from "#api/db/migrations";
import { deliverPendingEmails } from "#api/jobs/send-email";
import {
  cleanupSignupChallenges,
  issueSignupChallenge,
  resendSignupChallenge,
  verifySignupChallenge,
} from "#api/modules/auth/signup-challenge";
import { deriveSignupCode } from "#api/modules/auth/signup-token";
import { hashOpaqueToken } from "#api/modules/auth/token";
import { type ResendEmail, ResendEmailError } from "#api/modules/email/resend";
import {
  authTokenSecret,
  setupAuthDatabase,
} from "#api-test/support/auth-database";

const { admin, connectionString, databaseTest } = setupAuthDatabase();
const now = new Date("2026-10-21T00:00:00.000Z");
const options = { authTokenSecret, rateLimitSecret: "r".repeat(32) };
const at = (seconds: number) => () => new Date(now.getTime() + seconds * 1_000);
const email = "learner@example.com";
const start = (
  seconds = 0,
  address = "203.0.113.1",
  operation = randomUUID(),
) =>
  issueSignupChallenge(admin!, email, operation, address, options, at(seconds));
const codeFor = async (attemptToken: string) => {
  const result = await admin!.query<{ id: string }>(
    `SELECT code.id FROM auth_signup_codes code JOIN auth_signup_attempts attempt ON attempt.id = code.attempt_id
     WHERE attempt.token_hash = $1 ORDER BY code.created_at DESC LIMIT 1`,
    [hashOpaqueToken(attemptToken)],
  );
  return deriveSignupCode(result.rows[0]!.id, authTokenSecret);
};
const deliver = (
  sendEmail: (email: ResendEmail) => Promise<{ providerMessageId: string }>,
  seconds = 1,
  secret = authTokenSecret,
) =>
  deliverPendingEmails(
    { executeSql: (sql, values) => admin!.query(sql, values) },
    {
      authTokenSecret: secret,
      authTokenPreviousSecret: authTokenSecret,
      clock: at(seconds),
      from: "AMUQ <account@example.com>",
      sendEmail,
      webOrigin: "https://example.com",
    },
  );

databaseTest("signup ownership challenge", () => {
  it("issues and verifies without creating a user or persisting the raw credentials", async () => {
    await migrateDatabase(connectionString!);
    const challenge = await start();
    const code = await codeFor(challenge.attemptToken);
    const verified = await verifySignupChallenge(
      admin!,
      challenge.attemptToken,
      code,
      options,
      at(599),
    );
    expect(verified.status).toBe("verified");
    if (verified.status !== "verified")
      throw new Error("Expected verified proof");
    expect(verified.proofExpiresAt).toEqual(at(599 + 1_800)());
    const stored = await admin!
      .query(`SELECT row_to_json(attempt) AS attempt, row_to_json(code) AS code
      FROM auth_signup_attempts attempt JOIN auth_signup_codes code ON code.attempt_id = attempt.id`);
    const serialized = JSON.stringify(stored.rows);
    expect(serialized).not.toContain(challenge.attemptToken);
    expect(serialized).not.toContain(verified.signupProof);
    expect(stored.rows[0].code.code_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.values(stored.rows[0].code)).not.toContain(code);
    expect((await admin!.query("SELECT * FROM users")).rows).toEqual([]);
    expect((await admin!.query("SELECT * FROM auth_identities")).rows).toEqual(
      [],
    );
  });

  it("expires the code exactly at ten minutes and never extends a replayed proof", async () => {
    await migrateDatabase(connectionString!);
    const challenge = await start();
    const code = await codeFor(challenge.attemptToken);
    expect(
      await verifySignupChallenge(
        admin!,
        challenge.attemptToken,
        code,
        options,
        at(600),
      ),
    ).toMatchObject({ status: "expired" });
    const fresh = await start(601);
    const freshCode = await codeFor(fresh.attemptToken);
    const proof = await verifySignupChallenge(
      admin!,
      fresh.attemptToken,
      freshCode,
      options,
      at(602),
    );
    expect(
      await verifySignupChallenge(
        admin!,
        fresh.attemptToken,
        freshCode,
        options,
        at(2_401),
      ),
    ).toEqual(proof);
    expect(
      await verifySignupChallenge(
        admin!,
        fresh.attemptToken,
        freshCode,
        options,
        at(2_402),
      ),
    ).toMatchObject({ status: "expired" });
  });

  it("commits exactly five wrong guesses even under concurrent verification", async () => {
    await migrateDatabase(connectionString!);
    const challenge = await start();
    const correct = await codeFor(challenge.attemptToken);
    const wrong = correct === "000000" ? "000001" : "000000";
    const pool = new Pool({ connectionString, max: 6 });
    try {
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          verifySignupChallenge(
            pool,
            challenge.attemptToken,
            wrong,
            options,
            at(1),
          ),
        ),
      );
      expect(
        results.filter((result) => result.status === "invalid_code"),
      ).toHaveLength(4);
      expect(
        results.filter((result) => result.status === "attempts_exhausted"),
      ).toHaveLength(2);
      expect(
        (await admin!.query("SELECT wrong_attempts FROM auth_signup_codes"))
          .rows,
      ).toEqual([{ wrong_attempts: 5 }]);
      expect(
        await verifySignupChallenge(
          admin!,
          challenge.attemptToken,
          correct,
          options,
          at(2),
        ),
      ).toMatchObject({ status: "attempts_exhausted" });
    } finally {
      await pool.end();
    }
  });

  it("shares cooldown and three resends across fresh attempts, tabs, and addresses", async () => {
    await migrateDatabase(connectionString!);
    const first = await start();
    await expect(start(59, "203.0.113.2")).rejects.toMatchObject({
      retryAfterSeconds: 1,
    });
    for (const seconds of [60, 120, 180])
      await start(seconds, `203.0.113.${seconds}`);
    await expect(start(240, "203.0.113.9")).rejects.toMatchObject({
      retryAfterSeconds: 3_420,
    });
    await expect(
      resendSignupChallenge(
        admin!,
        first.attemptToken,
        randomUUID(),
        "203.0.113.10",
        options,
        at(3_659),
      ),
    ).rejects.toMatchObject({ retryAfterSeconds: 1 });
    await expect(start(3_660, "203.0.113.11")).resolves.toHaveProperty(
      "attemptToken",
    );
  });

  it("replays accepted initial and resend operations without new code, mail, or budget", async () => {
    await migrateDatabase(connectionString!);
    const operation = randomUUID();
    const first = await start(0, "203.0.113.1", operation);
    expect(await start(1, "203.0.113.2", operation)).toEqual(first);
    const resendOperation = randomUUID();
    const resent = await resendSignupChallenge(
      admin!,
      first.attemptToken,
      resendOperation,
      "203.0.113.1",
      options,
      at(60),
    );
    expect(
      await resendSignupChallenge(
        admin!,
        first.attemptToken,
        resendOperation,
        "203.0.113.2",
        options,
        at(61),
      ),
    ).toEqual(resent);
    expect(
      (await admin!.query("SELECT count(*)::int AS count FROM email_outbox"))
        .rows[0].count,
    ).toBe(2);
    expect(
      (
        await admin!.query(
          "SELECT sum(attempt_count)::int AS count FROM auth_rate_limits WHERE subject_kind = 'identifier'",
        )
      ).rows[0].count,
    ).toBe(3);
    await expect(
      issueSignupChallenge(
        admin!,
        "other@example.com",
        operation,
        "203.0.113.1",
        options,
        at(62),
      ),
    ).rejects.toThrow("Operation key conflict");
    await expect(
      resendSignupChallenge(
        admin!,
        first.attemptToken,
        operation,
        "203.0.113.1",
        options,
        at(62),
      ),
    ).rejects.toThrow("Operation key conflict");
  });

  it("rolls back a failed enqueue while retaining the admission budget", async () => {
    await migrateDatabase(connectionString!);
    await admin!
      .query(`CREATE FUNCTION fail_signup_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced enqueue failure'; END $$;
      CREATE TRIGGER fail_signup_outbox BEFORE INSERT ON email_outbox FOR EACH ROW EXECUTE FUNCTION fail_signup_outbox()`);
    try {
      await expect(start()).rejects.toThrow("forced enqueue failure");
      expect(
        (await admin!.query("SELECT * FROM auth_signup_attempts")).rows,
      ).toEqual([]);
      expect(
        (await admin!.query("SELECT * FROM auth_signup_codes")).rows,
      ).toEqual([]);
      expect(
        (
          await admin!.query(
            "SELECT attempt_count FROM auth_rate_limits WHERE scope = 'signup'",
          )
        ).rows,
      ).toEqual([{ attempt_count: 1 }, { attempt_count: 1 }]);
    } finally {
      await admin!.query(
        "DROP TRIGGER fail_signup_outbox ON email_outbox; DROP FUNCTION fail_signup_outbox()",
      );
    }
  });

  it("resends revoke old codes while preserving another attempt's valid proof", async () => {
    await migrateDatabase(connectionString!);
    const first = await start();
    const code = await codeFor(first.attemptToken);
    const proof = await verifySignupChallenge(
      admin!,
      first.attemptToken,
      code,
      options,
      at(1),
    );
    const next = await start(60, "203.0.113.2");
    expect(
      await verifySignupChallenge(
        admin!,
        first.attemptToken,
        code,
        options,
        at(61),
      ),
    ).toEqual(proof);
    const oldCode = await codeFor(next.attemptToken);
    await resendSignupChallenge(
      admin!,
      next.attemptToken,
      randomUUID(),
      "203.0.113.2",
      options,
      at(120),
    );
    expect(
      await verifySignupChallenge(
        admin!,
        next.attemptToken,
        oldCode,
        options,
        at(121),
      ),
    ).toMatchObject({ status: "invalid_code" });
  });

  it("uses a fresh clock after waiting for the email lock", async () => {
    await migrateDatabase(connectionString!);
    const challenge = await start();
    const code = await codeFor(challenge.attemptToken);
    const clock = vi
      .fn()
      .mockReturnValueOnce(at(599)())
      .mockReturnValue(at(600)());
    expect(
      await verifySignupChallenge(
        admin!,
        challenge.attemptToken,
        code,
        options,
        clock,
      ),
    ).toMatchObject({ status: "expired" });
  });

  it("delivers the same secret-derived six-digit payload after a lost response and key rotation", async () => {
    await migrateDatabase(connectionString!);
    const challenge = await start();
    const code = await codeFor(challenge.attemptToken);
    const sendEmail = vi
      .fn()
      .mockRejectedValueOnce(new ResendEmailError("request_timeout", true))
      .mockResolvedValueOnce({ providerMessageId: "signup-message" });
    expect(await deliver(sendEmail)).toEqual({
      failed: 0,
      retrying: 1,
      sent: 0,
    });
    expect(await deliver(sendEmail, 62, "b".repeat(32))).toEqual({
      failed: 0,
      retrying: 0,
      sent: 1,
    });
    expect(sendEmail.mock.calls[0]![0]).toEqual(sendEmail.mock.calls[1]![0]);
    expect(sendEmail.mock.calls[0]![0].text).toContain(code);
    expect(sendEmail.mock.calls[0]![0].text).toContain("10분");
    expect(sendEmail.mock.calls[0]![0].text).not.toContain("verify-email");
  });

  it("blocks guessing a verified code after five failed replay attempts without revoking the proof", async () => {
    await migrateDatabase(connectionString!);
    const challenge = await start();
    const correct = await codeFor(challenge.attemptToken);
    const proof = await verifySignupChallenge(
      admin!,
      challenge.attemptToken,
      correct,
      options,
      at(1),
    );
    const wrong = correct === "000000" ? "000001" : "000000";
    for (let count = 0; count < 5; count += 1)
      await verifySignupChallenge(
        admin!,
        challenge.attemptToken,
        wrong,
        options,
        at(2),
      );
    expect(
      await verifySignupChallenge(
        admin!,
        challenge.attemptToken,
        correct,
        options,
        at(3),
      ),
    ).toMatchObject({ status: "attempts_exhausted" });
    expect(proof.status).toBe("verified");
    expect(
      (
        await admin!.query(
          "SELECT proof_hash, proof_consumed_at FROM auth_signup_attempts",
        )
      ).rows[0],
    ).toMatchObject({
      proof_consumed_at: null,
      proof_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("reports the full quota wait even during the sixty-second cooldown", async () => {
    await migrateDatabase(connectionString!);
    for (const seconds of [0, 60, 120, 180]) await start(seconds);
    await expect(start(181)).rejects.toMatchObject({
      retryAfterSeconds: 3_479,
    });
  });

  it("returns the full next-allowed time when the accepted third resend exhausts its budget", async () => {
    await migrateDatabase(connectionString!);
    for (const seconds of [0, 60, 120]) await start(seconds);
    const operation = randomUUID();
    const third = await start(180, "203.0.113.1", operation);
    expect(third.resendAvailableAt).toEqual(at(3_660)());
    expect(await start(181, "203.0.113.1", operation)).toEqual(third);
  });

  it("serializes simultaneous issuance to one code and recovers the same accepted operation", async () => {
    await migrateDatabase(connectionString!);
    const pool = new Pool({ connectionString, max: 3 });
    try {
      const operation = randomUUID();
      const issue = (key: string) =>
        issueSignupChallenge(pool, email, key, "203.0.113.1", options, at(0));
      const result = await Promise.all([issue(operation), issue(operation)]);
      expect(result[0]).toEqual(result[1]);
      const next = await Promise.allSettled([
        issue(randomUUID()),
        issue(randomUUID()),
      ]);
      expect(next.every((result) => result.status === "rejected")).toBe(true);
      expect(
        (
          await admin!.query(
            "SELECT count(*)::int AS count FROM auth_signup_codes",
          )
        ).rows,
      ).toEqual([{ count: 1 }]);
    } finally {
      await pool.end();
    }
  });

  it("recovers an issued challenge and verified proof across signing-key rotation", async () => {
    await migrateDatabase(connectionString!);
    const operation = randomUUID();
    const first = await start(0, "203.0.113.1", operation);
    const code = await codeFor(first.attemptToken);
    const proof = await verifySignupChallenge(
      admin!,
      first.attemptToken,
      code,
      options,
      at(1),
    );
    const rotated = {
      ...options,
      authTokenSecret: "b".repeat(32),
      authTokenPreviousSecret: authTokenSecret,
    };
    expect(
      await issueSignupChallenge(
        admin!,
        email,
        operation,
        "203.0.113.1",
        rotated,
        at(2),
      ),
    ).toEqual(first);
    expect(
      await verifySignupChallenge(
        admin!,
        first.attemptToken,
        code,
        rotated,
        at(2),
      ),
    ).toEqual(proof);
  });

  it("does not send codes revoked or verified before delivery", async () => {
    await migrateDatabase(connectionString!);
    const first = await start();
    const second = await start(60);
    await verifySignupChallenge(
      admin!,
      second.attemptToken,
      await codeFor(second.attemptToken),
      options,
      at(61),
    );
    const sendEmail = vi.fn();
    expect(await deliver(sendEmail, 62)).toEqual({
      failed: 1,
      retrying: 0,
      sent: 0,
    });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(
      await verifySignupChallenge(
        admin!,
        first.attemptToken,
        "000000",
        options,
        at(62),
      ),
    ).toMatchObject({ status: "invalid_challenge" });
  });

  it("cleans expired attempts only after mail claims, proof, and shared issuance budgets end", async () => {
    await migrateDatabase(connectionString!);
    const first = await start();
    const second = await start(60);
    const code = await codeFor(second.attemptToken);
    await verifySignupChallenge(
      admin!,
      second.attemptToken,
      code,
      options,
      at(61),
    );
    const database = {
      executeSql: (sql: string, values?: unknown[]) =>
        admin!.query(sql, values),
    };
    expect(await cleanupSignupChallenges(database, at(3_659)())).toBe(0);
    // A pending/claimed row is retained even after its credential has expired.
    expect(await cleanupSignupChallenges(database, at(3_660)())).toBe(1);
    expect(
      (await admin!.query("SELECT token_hash FROM auth_signup_attempts")).rows,
    ).toEqual([{ token_hash: hashOpaqueToken(second.attemptToken) }]);
    await deliver(vi.fn(), 3_661);
    expect(await cleanupSignupChallenges(database, at(3_662)())).toBe(1);
    expect(
      (await admin!.query("SELECT * FROM auth_signup_codes")).rows,
    ).toEqual([]);
    expect(first.attemptToken).not.toBe(second.attemptToken);
  });

  it("enforces code attempts, exact lifetimes, and one outbox source in PostgreSQL", async () => {
    await migrateDatabase(connectionString!);
    await start();
    await expect(
      admin!.query("UPDATE auth_signup_codes SET wrong_attempts = 6"),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      admin!.query(
        "UPDATE auth_signup_codes SET expires_at = expires_at + interval '1 second'",
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      admin!.query("UPDATE email_outbox SET signup_code_id = NULL"),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("retains delivered mail and webhook history after temporary credentials expire", async () => {
    await migrateDatabase(connectionString!);
    await start();
    await deliver(async () => ({ providerMessageId: "retained-signup-mail" }));
    await admin!.query(
      `INSERT INTO email_webhook_events (event_id, outbox_id, event_type, occurred_at)
      SELECT 'retained-signup-event', id, 'email.complained', $1 FROM email_outbox`,
      [at(2)()],
    );
    const database = {
      executeSql: (sql: string, values?: unknown[]) =>
        admin!.query(sql, values),
    };
    expect(await cleanupSignupChallenges(database, at(3_601)())).toBe(1);
    expect(
      (await admin!.query("SELECT * FROM auth_signup_attempts")).rows,
    ).toEqual([]);
    expect(
      (await admin!.query("SELECT * FROM auth_signup_codes")).rows,
    ).toEqual([]);
    const retained = (await admin!.query("SELECT * FROM email_outbox")).rows;
    expect(retained[0]).toMatchObject({
      source_kind: "signup_code",
      signup_code_id: null,
      provider_message_id: "retained-signup-mail",
      payload_hash: null,
      token_key_id: null,
    });
    expect(JSON.stringify(retained)).not.toContain(email);
    expect(
      (await admin!.query("SELECT provider_message_id FROM email_outbox")).rows,
    ).toEqual([{ provider_message_id: "retained-signup-mail" }]);
    expect(
      (await admin!.query("SELECT event_id FROM email_webhook_events")).rows,
    ).toEqual([{ event_id: "retained-signup-event" }]);
    await admin!.query("UPDATE email_outbox SET status = 'complained'");
    await expect(
      admin!.query(
        "UPDATE email_outbox SET status = 'pending', token_key_id = repeat('a', 16)",
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "email_outbox_source_check",
    });
  });

  it("finishes bounded delivery-metadata erasure before deleting credential rows", async () => {
    await migrateDatabase(connectionString!);
    const challenge = await start();
    const attempt = (
      await admin!.query(
        "SELECT id FROM auth_signup_attempts WHERE token_hash = $1",
        [hashOpaqueToken(challenge.attemptToken)],
      )
    ).rows[0];
    await admin!.query(
      "UPDATE email_outbox SET status = 'sent', provider_message_id = 'history-initial', payload_hash = repeat('b', 64)",
    );
    await admin!.query(
      `WITH codes AS (
      INSERT INTO auth_signup_codes (attempt_id, recipient, operation_hash, operation_kind, code_digest, token_key_id, created_at, expires_at, resend_available_at)
      SELECT $1, $2, md5(i::text) || md5(i::text), 'resend', repeat('c',64), repeat('a',16), $3::timestamptz, $3::timestamptz + interval '10 minutes', $3::timestamptz + interval '1 minute'
      FROM generate_series(1,25) i RETURNING id
    ) INSERT INTO email_outbox (source_kind, signup_code_id, status, provider_message_id, payload_hash, token_key_id, created_at, updated_at)
      SELECT 'signup_code', id, 'sent', 'history-' || id::text, repeat('b',64), repeat('a',16), $3, $3 FROM codes`,
      [attempt.id, email, now],
    );
    const database = {
      executeSql: (sql: string, values?: unknown[]) =>
        admin!.query(sql, values),
    };
    expect(await cleanupSignupChallenges(database, at(3_601)())).toBe(0);
    expect(
      (
        await admin!.query(
          "SELECT count(*)::int AS count FROM email_outbox WHERE payload_hash IS NOT NULL OR token_key_id IS NOT NULL",
        )
      ).rows[0].count,
    ).toBe(1);
    expect(await cleanupSignupChallenges(database, at(3_602)())).toBe(1);
    expect(
      (await admin!.query("SELECT * FROM auth_signup_codes")).rows,
    ).toEqual([]);
    expect(
      (
        await admin!.query(
          "SELECT count(*)::int AS count FROM email_outbox WHERE payload_hash IS NULL AND token_key_id IS NULL AND signup_code_id IS NULL",
        )
      ).rows[0].count,
    ).toBe(26);
  });

  it("does not charge quotas for a challenge already verified", async () => {
    await migrateDatabase(connectionString!);
    const challenge = await start();
    await verifySignupChallenge(
      admin!,
      challenge.attemptToken,
      await codeFor(challenge.attemptToken),
      options,
      at(1),
    );
    const before = await admin!.query(
      "SELECT * FROM auth_rate_limits ORDER BY subject_kind",
    );
    await expect(
      resendSignupChallenge(
        admin!,
        challenge.attemptToken,
        randomUUID(),
        "203.0.113.1",
        options,
        at(60),
      ),
    ).rejects.toThrow("Signup already verified");
    expect(
      (
        await admin!.query(
          "SELECT * FROM auth_rate_limits ORDER BY subject_kind",
        )
      ).rows,
    ).toEqual(before.rows);
  });

  it("returns expired verification and permits reissuance when the old signing key is unavailable", async () => {
    await migrateDatabase(connectionString!);
    const challenge = await start();
    const code = await codeFor(challenge.attemptToken);
    const rotated = { ...options, authTokenSecret: "b".repeat(32) };
    expect(
      await verifySignupChallenge(
        admin!,
        challenge.attemptToken,
        code,
        rotated,
        at(1),
      ),
    ).toMatchObject({ status: "expired" });
    const reissued = await resendSignupChallenge(
      admin!,
      challenge.attemptToken,
      randomUUID(),
      "203.0.113.1",
      rotated,
      at(60),
    );
    expect(reissued.attemptToken).toBe(challenge.attemptToken);
    const latest = (
      await admin!.query(
        "SELECT id FROM auth_signup_codes ORDER BY created_at DESC LIMIT 1",
      )
    ).rows[0];
    expect(
      await verifySignupChallenge(
        admin!,
        challenge.attemptToken,
        deriveSignupCode(latest.id, rotated.authTokenSecret),
        rotated,
        at(61),
      ),
    ).toMatchObject({ status: "verified" });
  });

  it("rechecks a cleanup candidate changed after its statement snapshot", async () => {
    await migrateDatabase(connectionString!);
    const challenge = await start();
    await admin!.query("UPDATE email_outbox SET status = 'failed'");
    const pool = new Pool({
      connectionString,
      max: 3,
      application_name: "signup-cleanup-race",
    });
    const blocker = await pool.connect();
    let cleanup: Promise<number> | undefined;
    await admin!
      .query(`CREATE FUNCTION signup_cleanup_barrier() RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
      BEGIN PERFORM pg_advisory_xact_lock(893121); RETURN true; END $$`);
    try {
      await blocker.query("SELECT pg_advisory_lock(893121)");
      const database = {
        executeSql: (sql: string, values?: unknown[]) =>
          pool.query(
            sql.replace(
              "ORDER BY attempt.",
              "AND signup_cleanup_barrier() ORDER BY attempt.",
            ),
            values,
          ),
      };
      cleanup = cleanupSignupChallenges(database, at(3_600)());
      await vi.waitFor(async () => {
        const waiting = await admin!.query(
          "SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name = 'signup-cleanup-race' AND wait_event_type = 'Lock' AND query LIKE 'WITH expired AS%'",
        );
        expect(waiting.rows[0].count).toBe(1);
      });
      await resendSignupChallenge(
        admin!,
        challenge.attemptToken,
        randomUUID(),
        "203.0.113.1",
        options,
        at(3_600),
      );
      await blocker.query("SELECT pg_advisory_unlock(893121)");
      expect(await cleanup).toBe(0);
      expect(
        await verifySignupChallenge(
          admin!,
          challenge.attemptToken,
          await codeFor(challenge.attemptToken),
          options,
          at(3_601),
        ),
      ).toMatchObject({ status: "verified" });
    } finally {
      await blocker.query("SELECT pg_advisory_unlock(893121)");
      await cleanup?.catch(() => undefined);
      blocker.release();
      await pool.end();
      await admin!.query("DROP FUNCTION signup_cleanup_barrier()");
    }
  });

  it.each(["verify_first", "resend_first"] as const)(
    "serializes %s without replacing a granted proof",
    async (ordering) => {
      await migrateDatabase(connectionString!);
      const challenge = await start();
      const oldCode = await codeFor(challenge.attemptToken);
      const pool = new Pool({
        connectionString,
        max: 3,
        application_name: "signup-verify-resend-race",
      });
      const blocker = await pool.connect();
      let requests: Promise<PromiseSettledResult<unknown>[]> | undefined;
      try {
        await blocker.query("BEGIN");
        await blocker.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`amuq:signup-email:${email}`],
        );
        const waitForQueued = async (count: number) =>
          vi.waitFor(async () => {
            const waiting = await admin!.query(
              "SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name = 'signup-verify-resend-race' AND wait_event_type = 'Lock'",
            );
            expect(waiting.rows[0].count).toBe(count);
          });
        const verify = () =>
          verifySignupChallenge(
            pool,
            challenge.attemptToken,
            oldCode,
            options,
            at(60),
          );
        const reissue = () =>
          resendSignupChallenge(
            pool,
            challenge.attemptToken,
            randomUUID(),
            "203.0.113.1",
            options,
            at(60),
          );
        const first = ordering === "verify_first" ? verify() : reissue();
        // Register rejection handlers before releasing either queued request.
        const firstSettled = Promise.allSettled([first]);
        await waitForQueued(1);
        const second = ordering === "verify_first" ? reissue() : verify();
        requests = Promise.allSettled([first, second]);
        await waitForQueued(2);
        await blocker.query("COMMIT");
        const settled = await requests;
        await firstSettled;
        const [verified, resent] =
          ordering === "verify_first" ? settled : [settled[1], settled[0]];
        expect(verified!.status).toBe("fulfilled");
        if (verified!.status !== "fulfilled")
          throw new Error("Verification rejected");
        const firstProof = verified!.value as Awaited<
          ReturnType<typeof verifySignupChallenge>
        >;
        const final = await verifySignupChallenge(
          admin!,
          challenge.attemptToken,
          await codeFor(challenge.attemptToken),
          options,
          at(61),
        );
        expect(final.status).toBe("verified");
        if (firstProof.status === "verified") expect(final).toEqual(firstProof);
        else expect(resent!.status).toBe("fulfilled");
        expect(
          (
            await admin!.query(
              "SELECT count(*)::int AS count FROM auth_signup_codes",
            )
          ).rows[0].count,
        ).toBe(ordering === "verify_first" ? 1 : 2);
      } finally {
        await blocker.query("ROLLBACK");
        await requests;
        blocker.release();
        await pool.end();
      }
    },
  );

  it("retires expired signup mail without calling its provider", async () => {
    await migrateDatabase(connectionString!);
    await start();
    const sendEmail = vi.fn();
    expect(await deliver(sendEmail, 600)).toEqual({
      failed: 1,
      retrying: 0,
      sent: 0,
    });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(
      (await admin!.query("SELECT status, last_error_code FROM email_outbox"))
        .rows,
    ).toEqual([{ status: "failed", last_error_code: "token_expired" }]);
  });

  it("does not send or overwrite a signup mail reclaimed during payload preparation", async () => {
    await migrateDatabase(connectionString!);
    await start();
    let seconds = 1;
    const database = {
      executeSql: async (sql: string, values?: unknown[]) => {
        const result = await admin!.query(sql, values);
        if (sql.includes("SET payload_hash = $2")) {
          await admin!.query("UPDATE email_outbox SET updated_at = $1", [
            at(2)(),
          ]);
          seconds = 3;
        }
        return result;
      },
    };
    const sendEmail = vi.fn();
    expect(
      await deliverPendingEmails(database, {
        authTokenSecret,
        clock: () => at(seconds)(),
        from: "AMUQ <account@example.com>",
        sendEmail,
        webOrigin: "https://example.com",
      }),
    ).toEqual({ failed: 0, retrying: 0, sent: 0 });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(
      (await admin!.query("SELECT status, updated_at FROM email_outbox")).rows,
    ).toEqual([{ status: "pending", updated_at: at(2)() }]);
  });

  it("does not log signup code or bearer credentials", async () => {
    await migrateDatabase(connectionString!);
    const spies = (["log", "info", "warn", "error"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    try {
      const challenge = await start();
      const code = await codeFor(challenge.attemptToken);
      const verified = await verifySignupChallenge(
        admin!,
        challenge.attemptToken,
        code,
        options,
        at(1),
      );
      if (verified.status !== "verified")
        throw new Error("Expected verified proof");
      const logs = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
      for (const credential of [
        code,
        challenge.attemptToken,
        verified.signupProof,
      ])
        expect(logs).not.toContain(credential);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });
});
