import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { expect, it, vi } from "vitest";

import { migrateDatabase } from "#backend/db/migrations";
import {
  issueSignupChallenge,
  resendSignupChallenge,
  verifySignupChallenge,
} from "#backend/modules/auth/signup-challenge";
import { setupSignupChallenge } from "#backend-test/support/auth-signup-challenge";

const {
  admin,
  connectionString,
  options,
  at,
  email,
  start,
  codeFor,
  databaseTest,
} = setupSignupChallenge();

databaseTest("signup ownership challenge", () => {
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
});
