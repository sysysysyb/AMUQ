import { Pool } from "pg";
import { expect, it, vi } from "vitest";

import { migrateDatabase } from "#backend/db/migrations";
import { requestPasswordReset } from "#backend/modules/auth/service";
import {
  authTokenSecret,
  setupAuthDatabase,
} from "#backend-test/support/auth-database";

const { admin, connectionString, createVerifiedPasswordLogin, databaseTest } =
  setupAuthDatabase();

databaseTest("authentication email delivery and rate limits", () => {
  it.each(["password_reset"] as const)(
    "does not issue %s for an account created after an empty user-lock query",
    async (purpose) => {
      await migrateDatabase(connectionString!);
      const now = new Date("2026-10-19T00:00:00.000Z");
      const email = "created-after-lock@example.com";
      const options = { authTokenSecret, rateLimitSecret: "r".repeat(32) };
      const pool = new Pool({ connectionString, max: 1 });
      let accountCreated = false;
      const database = {
        query: pool.query.bind(pool),
        connect: async () => {
          const client = await pool.connect();
          return new Proxy(client, {
            get(target, property, receiver) {
              if (property === "query") {
                return async (sql: string, values?: unknown[]) => {
                  const result = await target.query(sql, values);
                  if (
                    sql ===
                      "SELECT id FROM users WHERE email = $1 FOR UPDATE" &&
                    result.rows.length === 0 &&
                    !accountCreated
                  ) {
                    accountCreated = true;
                    await createVerifiedPasswordLogin(
                      email,
                      "ValidPass1234",
                      "203.0.113.81",
                      now,
                    );
                  }
                  return result;
                };
              }
              const value = Reflect.get(target, property, receiver);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        },
      } as unknown as Pool;
      const reissue = requestPasswordReset;
      try {
        await reissue(database, email, "203.0.113.82", options, now);
        expect(accountCreated).toBe(true);
        const tokens = await admin!.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM auth_tokens
           JOIN users ON users.id = auth_tokens.user_id
           WHERE users.email = $1 AND purpose = $2`,
          [email, purpose],
        );
        const expectedCount = "0";
        expect(tokens.rows).toEqual([{ count: expectedCount }]);
        const pending = await admin!.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM email_outbox
           JOIN auth_tokens ON auth_tokens.id = email_outbox.token_id
           JOIN users ON users.id = auth_tokens.user_id
           WHERE users.email = $1 AND purpose = $2 AND status = 'pending'`,
          [email, purpose],
        );
        expect(pending.rows).toEqual([{ count: expectedCount }]);
      } finally {
        await pool.end();
      }
    },
    10_000,
  );

  it.each(["password_reset"] as const)(
    "serializes concurrent %s reissues after waiting for the user lock",
    async (purpose) => {
      await migrateDatabase(connectionString!);
      const now = new Date("2026-10-18T00:00:00.000Z");
      const email = "concurrent-reissue@example.com";
      const options = { authTokenSecret, rateLimitSecret: "r".repeat(32) };
      await createVerifiedPasswordLogin(
        email,
        "ValidPass1234",
        "203.0.113.71",
        now,
      );
      const applicationName = `amuq-reissue-${purpose}`;
      const pool = new Pool({
        connectionString,
        application_name: applicationName,
        max: 3,
      });
      const blocker = await pool.connect();
      let requests: Promise<PromiseSettledResult<unknown>[]> | undefined;
      try {
        await blocker.query("BEGIN");
        await blocker.query(
          "SELECT id FROM users WHERE email = $1 FOR UPDATE",
          [email],
        );
        const reissue = requestPasswordReset;
        requests = Promise.allSettled([
          reissue(pool, email, "203.0.113.72", options, now),
          reissue(pool, email, "203.0.113.73", options, now),
        ]);
        await vi.waitFor(
          async () => {
            const waiting = await admin!.query<{ count: string }>(
              "SELECT count(*)::text AS count FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock' AND query LIKE '%FOR UPDATE%'",
              [applicationName],
            );
            expect(waiting.rows).toEqual([{ count: "2" }]);
          },
          { timeout: 3_000, interval: 10 },
        );
        await blocker.query("COMMIT");
        const outcomes = await requests;
        for (const outcome of outcomes) {
          if (outcome.status === "rejected") throw outcome.reason;
        }
        const active = await admin!.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM auth_tokens WHERE purpose = $1 AND consumed_at IS NULL AND expires_at > $2",
          [purpose, now],
        );
        expect(active.rows).toEqual([{ count: "1" }]);
        const pending = await admin!.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM email_outbox JOIN auth_tokens ON auth_tokens.id = email_outbox.token_id WHERE auth_tokens.purpose = $1 AND email_outbox.status = 'pending'",
          [purpose],
        );
        expect(pending.rows).toEqual([{ count: "1" }]);
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
        if (requests) await requests;
        await pool.end();
      }
    },
    10_000,
  );
});
