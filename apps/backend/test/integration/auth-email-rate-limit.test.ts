import { Pool } from "pg";
import { expect, it } from "vitest";

import { migrateDatabase } from "#backend/db/migrations";
import { buildServer } from "#backend/http/server";
import {
  AuthRateLimitExceededError,
  consumeAuthRateLimit,
} from "#backend/modules/auth/rate-limit";
import { requestPasswordReset } from "#backend/modules/auth/service";
import {
  authTokenSecret,
  setupAuthDatabase,
} from "#backend-test/support/auth-database";

const { admin, connectionString, createVerifiedPasswordLogin, databaseTest } =
  setupAuthDatabase();

databaseTest("authentication email delivery and rate limits", () => {
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
});
