import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { expect, it, vi } from "vitest";

import { migrateDatabase } from "#api/db/migrations";
import { buildServer } from "#api/http/server";
import { deliverPendingEmails } from "#api/jobs/send-email";
import {
  AuthRateLimitExceededError,
  consumeAuthRateLimit,
} from "#api/modules/auth/rate-limit";
import { requestPasswordReset } from "#api/modules/auth/service";
import {
  issueSignupChallenge,
  resendSignupChallenge,
} from "#api/modules/auth/signup-challenge";
import type { ResendEmail } from "#api/modules/email/resend";
import {
  authTokenSecret,
  setupAuthDatabase,
} from "#api-test/support/auth-database";

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

  it("allows three reset resends independently of the initial email and recovers after expiry", async () => {
    await migrateDatabase(connectionString!);
    const now = new Date("2026-10-15T00:00:00.000Z");
    const email = "reset-quota@example.com";
    const address = "203.0.113.120";
    const options = {
      authTokenSecret,
      rateLimitSecret: "r".repeat(32),
    };
    await createVerifiedPasswordLogin(email, "ValidPass1234", address, now);
    await requestPasswordReset(admin!, email, address, options, now);
    for (let remaining = 2; remaining >= 0; remaining--) {
      await expect(
        requestPasswordReset(
          admin!,
          email,
          address,
          { ...options, resend: true },
          now,
        ),
      ).resolves.toEqual({ limit: 3, remaining, retryAfterSeconds: 3600 });
    }
    await expect(
      requestPasswordReset(
        admin!,
        email,
        address,
        { ...options, resend: true },
        now,
      ),
    ).rejects.toBeInstanceOf(AuthRateLimitExceededError);
    const queued = await admin!.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM email_outbox
         JOIN auth_tokens ON auth_tokens.id = email_outbox.token_id
        WHERE auth_tokens.purpose = 'password_reset'`,
    );
    expect(queued.rows).toEqual([{ count: "4" }]);
    await expect(
      requestPasswordReset(
        admin!,
        email,
        address,
        { ...options, resend: true },
        new Date(now.getTime() + 3_600_000),
      ),
    ).resolves.toEqual({ limit: 3, remaining: 2, retryAfterSeconds: 3600 });
  });

  it("reports atomic email request quotas without revealing account existence", async () => {
    await migrateDatabase(connectionString!);
    const server = await buildServer({
      auth: {
        allowedOrigins: ["https://web.example"],
        authTokenSecret,
        database: admin!,
        rateLimitSecret: "r".repeat(32),
        webOrigin: "https://web.example",
      },
      environment: "test",
    });
    try {
      for (const identifierLimited of [false, true]) {
        for (const url of [
          "/auth/password-reset/request",
          "/auth/password-reset/resend",
        ]) {
          for (let remaining = 2; remaining >= 0; remaining--) {
            const response = await server.inject({
              method: "POST",
              url,
              headers: { origin: "https://web.example" },
              payload: {
                email: identifierLimited
                  ? "identifier@example.com"
                  : `missing-${remaining}@example.com`,
              },
              remoteAddress: identifierLimited
                ? `203.0.113.${91 + remaining}`
                : "203.0.113.90",
            });
            expect(response.statusCode).toBe(202);
            expect(response.json()).toEqual({
              status: "accepted",
              rateLimit: {
                limit: 3,
                remaining,
                retryAfterSeconds: expect.any(Number),
              },
            });
            expect(response.json().rateLimit.retryAfterSeconds).toBeGreaterThan(
              3500,
            );
          }
          const blocked = await server.inject({
            method: "POST",
            url,
            headers: { origin: "https://web.example" },
            payload: {
              email: identifierLimited
                ? "IDENTIFIER@example.com"
                : "another@example.com",
            },
            remoteAddress: identifierLimited ? "203.0.113.94" : "203.0.113.90",
          });
          expect(blocked.statusCode).toBe(429);
          expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(3500);
        }
      }
    } finally {
      await server.close();
    }
  }, 10_000);

  it("atomically rate-limits both hashed subjects and recovers after cleanup", async () => {
    await migrateDatabase(connectionString!);
    const now = new Date("2026-09-27T00:00:00.000Z");
    const secret = "r".repeat(32);
    const concurrentPool = new Pool({ connectionString, max: 6 });

    const concurrent = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        consumeAuthRateLimit(
          concurrentPool,
          "signup",
          "203.0.113.10",
          "rate@example.com",
          secret,
          now,
        ),
      ),
    );
    await concurrentPool.end();
    expect(
      concurrent.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(5);
    const rejected = concurrent.find(({ status }) => status === "rejected");
    expect(rejected).toMatchObject({
      reason: expect.any(AuthRateLimitExceededError),
      status: "rejected",
    });
    expect((rejected as PromiseRejectedResult).reason.retryAfterSeconds).toBe(
      3600,
    );

    const stored = await admin!.query<{
      attemptCount: number;
      subjectHash: string;
    }>(
      'SELECT attempt_count AS "attemptCount", subject_hash AS "subjectHash" FROM auth_rate_limits ORDER BY subject_kind',
    );
    expect(stored.rows).toHaveLength(2);
    expect(stored.rows.every(({ attemptCount }) => attemptCount === 5)).toBe(
      true,
    );
    expect(JSON.stringify(stored.rows)).not.toContain("203.0.113.10");
    expect(JSON.stringify(stored.rows)).not.toContain("rate@example.com");

    await consumeAuthRateLimit(
      admin!,
      "signup",
      "203.0.113.10",
      "rate@example.com",
      "s".repeat(32),
      now,
    );
    const separated = await admin!.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM auth_rate_limits",
    );
    expect(separated.rows).toEqual([{ count: "4" }]);

    await consumeAuthRateLimit(
      admin!,
      "signup",
      "203.0.113.10",
      "rate@example.com",
      secret,
      new Date(now.getTime() + 60 * 60 * 1_000),
    );
    const recovered = await admin!.query<{ attemptCount: number }>(
      'SELECT attempt_count AS "attemptCount" FROM auth_rate_limits',
    );
    expect(recovered.rows).toEqual([{ attemptCount: 1 }, { attemptCount: 1 }]);
  });

  it("waits for every exhausted subject and rolls back rejected attempts", async () => {
    await migrateDatabase(connectionString!);
    const start = new Date("2026-09-27T00:00:00.000Z");
    const secret = "r".repeat(32);
    for (let index = 0; index < 3; index++) {
      await consumeAuthRateLimit(
        admin!,
        "verification_resend",
        "203.0.113.100",
        `ip-${index}@example.com`,
        secret,
        start,
      );
      await consumeAuthRateLimit(
        admin!,
        "verification_resend",
        `203.0.113.${101 + index}`,
        "blocked@example.com",
        secret,
        new Date(start.getTime() + 60_000),
      );
    }
    const before = await admin!.query(
      "SELECT * FROM auth_rate_limits ORDER BY subject_kind, subject_hash",
    );
    await expect(
      consumeAuthRateLimit(
        admin!,
        "verification_resend",
        "203.0.113.100",
        "blocked@example.com",
        secret,
        new Date(start.getTime() + 120_000),
      ),
    ).rejects.toMatchObject({ retryAfterSeconds: 3540 });
    await expect(
      consumeAuthRateLimit(
        admin!,
        "verification_resend",
        "203.0.113.100",
        "blocked@example.com",
        secret,
        new Date(start.getTime() + 3_600_000),
      ),
    ).rejects.toMatchObject({ retryAfterSeconds: 60 });
    const after = await admin!.query(
      "SELECT * FROM auth_rate_limits ORDER BY subject_kind, subject_hash",
    );
    expect(after.rows).toEqual(before.rows);
    await expect(
      consumeAuthRateLimit(
        admin!,
        "verification_resend",
        "203.0.113.100",
        "blocked@example.com",
        secret,
        new Date(start.getTime() + 3_660_000),
      ),
    ).resolves.toMatchObject({
      limit: 3,
      remaining: 2,
      retryAfterSeconds: 3600,
    });
  });

  it("delivers an active email despite an older consumed-token backlog", async () => {
    await migrateDatabase(connectionString!);
    const now = new Date("2026-09-27T01:00:00.000Z");
    await issueSignupChallenge(
      admin!,
      "active@example.com",
      randomUUID(),
      "203.0.113.30",
      { authTokenSecret, rateLimitSecret: "r".repeat(32) },
      () => now,
    );
    const user = await admin!.query<{ id: string }>(
      "INSERT INTO users (email) VALUES ('backlog@example.com') RETURNING id::text",
    );
    await admin!.query(
      `WITH tokens AS (
         INSERT INTO auth_tokens
           (user_id, purpose, token_hash, created_at, expires_at, consumed_at)
         SELECT $1,
                'email_verification',
                md5(sequence::text) || md5(sequence::text),
                 $2::timestamptz - interval '2 hours' + sequence * interval '1 second',
                 $2::timestamptz + interval '1 hour',
                $2
           FROM generate_series(1, 26) AS sequence
         RETURNING id, created_at
       )
       INSERT INTO email_outbox (token_id, token_key_id, created_at, updated_at)
       SELECT id, 'aaaaaaaaaaaaaaaa', created_at, created_at FROM tokens`,
      [user.rows[0]!.id, now],
    );
    const sendEmail = vi.fn<
      (email: ResendEmail) => Promise<{ providerMessageId: string }>
    >(async () => ({
      providerMessageId: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794",
    }));

    await expect(
      deliverPendingEmails(
        { executeSql: (sql, values) => admin!.query(sql, values) },
        {
          authTokenSecret,
          clock: () => now,
          from: "AMUQ <account@example.com>",
          sendEmail,
          webOrigin: "https://example.com",
        },
      ),
    ).resolves.toEqual({ failed: 25, retrying: 0, sent: 1 });
    expect(sendEmail).toHaveBeenCalledOnce();
    expect(sendEmail.mock.calls[0]![0].to).toBe("active@example.com");
    const backlog = await admin!.query<{
      count: string;
      lastErrorCode: string | null;
      status: string;
    }>(
      `SELECT outbox.status,
              outbox.last_error_code AS "lastErrorCode",
              count(*)::text
         FROM email_outbox AS outbox
         JOIN auth_tokens AS token ON token.id = outbox.token_id
        WHERE token.consumed_at IS NOT NULL
        GROUP BY outbox.status, outbox.last_error_code
        ORDER BY outbox.status::text`,
    );
    expect(backlog.rows).toEqual([
      { count: "25", lastErrorCode: "token_consumed", status: "failed" },
      { count: "1", lastErrorCode: null, status: "pending" },
    ]);
  });

  it("does not overwrite an active delivery when resend supersedes its token", async () => {
    await migrateDatabase(connectionString!);
    const now = new Date("2026-09-27T01:00:00.000Z");
    const options = {
      authTokenSecret,
      rateLimitSecret: "r".repeat(32),
    };
    const challenge = await issueSignupChallenge(
      admin!,
      "resend-during-delivery@example.com",
      randomUUID(),
      "203.0.113.31",
      options,
      () => new Date(now.getTime() - 60_000),
    );
    const deliveryPool = new Pool({ connectionString, max: 2 });
    const database = {
      executeSql: async (text: string, values?: unknown[]) =>
        deliveryPool.query(text, values),
    };
    let acceptDelivery!: () => void;
    const deliveryAccepted = new Promise<void>((resolve) => {
      acceptDelivery = resolve;
    });
    let deliveryCount = 0;
    const sendEmail = vi.fn(async () => {
      deliveryCount += 1;
      if (deliveryCount === 1) await deliveryAccepted;
      return {
        providerMessageId:
          deliveryCount === 1
            ? "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794"
            : "c80f71b7-8c27-4f11-8b33-c5cac2c8a890",
      };
    });
    let currentTime = new Date(now.getTime() + 1_000);
    const delivery = deliverPendingEmails(database, {
      authTokenSecret,
      clock: () => currentTime,
      from: "AMUQ <account@example.com>",
      sendEmail,
      webOrigin: "https://example.com",
    });

    try {
      await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledOnce());
      await resendSignupChallenge(
        admin!,
        challenge.attemptToken,
        randomUUID(),
        "203.0.113.32",
        options,
        () => new Date(now.getTime() + 2_000),
      );
      currentTime = new Date(now.getTime() + 3_000);
      acceptDelivery();

      const deliveryResult = await delivery;
      const stored = await admin!.query<{
        attemptCount: number;
        lastErrorCode: string | null;
        providerMessageId: string | null;
        status: string;
      }>(
        `SELECT attempt_count AS "attemptCount",
                last_error_code AS "lastErrorCode",
                provider_message_id AS "providerMessageId",
                status
           FROM email_outbox
          ORDER BY created_at, id`,
      );
      expect({ deliveryResult, stored: stored.rows }).toEqual({
        deliveryResult: {
          failed: 0,
          retrying: 0,
          sent: 2,
        },
        stored: [
          {
            attemptCount: 1,
            lastErrorCode: null,
            providerMessageId: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794",
            status: "sent",
          },
          {
            attemptCount: 1,
            lastErrorCode: null,
            providerMessageId: "c80f71b7-8c27-4f11-8b33-c5cac2c8a890",
            status: "sent",
          },
        ],
      });
    } finally {
      acceptDelivery();
      await delivery.catch(() => undefined);
      await deliveryPool.end();
    }
  });
});
