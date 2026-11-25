import { Pool } from "pg";
import { expect, it } from "vitest";

import { migrateDatabase } from "#backend/db/migrations";
import { consumePasswordLoginIp } from "#backend/modules/auth/login-rate-limit";
import { setupAuthDatabase } from "#backend-test/support/auth-database";
import { authRateLimitSecret as secret } from "#backend-test/support/auth-test-secrets";

const { admin, connectionString, databaseTest } = setupAuthDatabase();

databaseTest("password login budgets", () => {
  it("cleans at most 128 expired rows and leaves locked expired rows alone", async () => {
    await migrateDatabase(connectionString!);
    await admin!
      .query(`INSERT INTO auth_password_login_limits (subject_kind, subject_hash, window_started_at, expires_at)
      SELECT 'client_address', lpad(to_hex(n), 64, '0'), clock_timestamp() - interval '16 minutes', clock_timestamp() - interval '1 minute' FROM generate_series(1, 130) AS n`);
    const pool = new Pool({ connectionString, max: 1 });
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT 1 FROM auth_password_login_limits WHERE subject_hash = lpad('1', 64, '0') FOR UPDATE",
      );
      await consumePasswordLoginIp(admin!, "ip1", secret);
      expect(
        (
          await admin!.query(
            "SELECT count(*)::int AS count FROM auth_password_login_limits WHERE expires_at < clock_timestamp()",
          )
        ).rows[0].count,
      ).toBe(2);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await pool.end();
    }
  });

  it.each([
    ["client_address", 101, "'{}'::uuid[]"],
    ["client_address", 0, "ARRAY[gen_random_uuid()]"],
    ["identifier_client_address", 10, "ARRAY[gen_random_uuid()]"],
    ["identifier_client_address", -1, "'{}'::uuid[]"],
    ["identifier_client_address", 0, "ARRAY[NULL]::uuid[]"],
    ["identifier_client_address", 0, "ARRAY[ARRAY[gen_random_uuid()]]"],
  ])(
    "rejects invalid persisted budget: %s / %s / %s",
    async (kind, count, pending) => {
      await migrateDatabase(connectionString!);
      await expect(
        admin!.query(
          `INSERT INTO auth_password_login_limits (subject_kind, subject_hash, window_started_at, expires_at, attempt_count, pending_attempts)
      VALUES ($1, repeat('a', 64), clock_timestamp(), clock_timestamp() + interval '15 minutes', $2, ${pending})`,
          [kind, count],
        ),
      ).rejects.toThrow();
    },
  );

  it("shares IP requests across pairs, admits exactly 100, and leaves expiry fixed when blocked", async () => {
    await migrateDatabase(connectionString!);
    await consumePasswordLoginIp(admin!, "ip1", secret);
    const initial = (
      await admin!.query("SELECT expires_at FROM auth_password_login_limits")
    ).rows[0];
    for (let i = 1; i < 100; i++)
      await consumePasswordLoginIp(admin!, "ip1", secret);
    await expect(
      consumePasswordLoginIp(admin!, "ip1", secret),
    ).rejects.toMatchObject({ retryAfterSeconds: expect.any(Number) });
    expect(
      (
        await admin!.query(
          "SELECT attempt_count, expires_at FROM auth_password_login_limits",
        )
      ).rows[0],
    ).toEqual({ attempt_count: 100, expires_at: initial.expires_at });
  });
});
