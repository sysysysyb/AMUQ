import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

const password = vi.hoisted(() => ({
  hashPassword: vi.fn(async () => "hashed-password"),
  verifyPassword: vi.fn(async () => false),
}));

vi.mock("#api/modules/auth/password", () => password);

import { withPasswordLoginAttempt } from "#api/modules/auth/login-rate-limit";
import {
  authenticatePassword,
  exchangePasswordResetToken,
  requestPasswordReset,
  resetPassword,
} from "#api/modules/auth/service";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("authentication transaction boundaries", () => {
  it("commits and releases admission before Argon2 and holds the reservation until verification finishes", async () => {
    let leased = false;
    let pending = false;
    const now = new Date();
    let resume!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("array_append")) pending = true;
        if (sql.includes("array_remove")) pending = false;
        if (sql.includes("SELECT clock_timestamp()"))
          return { rows: [{ now }] };
        return {
          rows: [
            {
              windowId: "window",
              expiresAt: new Date(now.getTime() + 900_000),
              attemptCount: 0,
              pendingAttempts: [],
            },
          ],
        };
      }),
      release: () => {
        leased = false;
      },
    };
    const database = {
      connect: async () => {
        leased = true;
        return client;
      },
      query: async () => ({ rows: [] }),
    } as unknown as Pool;
    password.verifyPassword.mockImplementationOnce(async () => {
      expect(leased).toBe(false);
      expect(pending).toBe(true);
      entered();
      await gate;
      return false;
    });
    const request = withPasswordLoginAttempt(
      database,
      "missing@example.test",
      "ip1",
      "r".repeat(32),
      (attempt) =>
        authenticatePassword(
          database,
          "missing@example.test",
          "wrong",
          now,
          attempt,
        ),
    );
    await started;
    expect(pending).toBe(true);
    expect(leased).toBe(false);
    resume();
    await expect(request).resolves.toBeUndefined();
    expect(
      client.query.mock.calls.filter(([sql]) => sql === "BEGIN").length,
    ).toBeGreaterThan(1);
    expect(leased).toBe(false);
  });
  it.each([["password reset", requestPasswordReset, 30 * 60 * 1_000]] as const)(
    "starts the %s token lifetime after acquiring the user lock",
    async (_name, operation, lifetime) => {
      const checkedAt = new Date("2026-10-19T00:00:00.000Z");
      const issuedAt = new Date(checkedAt.getTime() + 60_000);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(checkedAt);
      const client = {
        query: vi.fn(async (sql: string, values?: unknown[]) => {
          if (sql.includes("INSERT INTO auth_rate_limits")) {
            return {
              rows: [
                {
                  attemptCount: 1,
                  expiresAt: new Date(checkedAt.getTime() + 3_600_000),
                },
              ],
            };
          }
          if (
            sql.includes("SELECT id FROM users WHERE email = $1 FOR UPDATE")
          ) {
            expect(values).toEqual(["learner@example.com"]);
            vi.setSystemTime(issuedAt);
            return { rows: [{ id: "user-id" }] };
          }
          return { rows: [] };
        }),
        release: vi.fn(),
      };
      const database = {
        connect: vi.fn(async () => client),
      } as unknown as Pool;
      try {
        await operation(database, "learner@example.com", "203.0.113.10", {
          authTokenSecret: "a".repeat(32),
          rateLimitSecret: "r".repeat(32),
        });
        const issuance = client.query.mock.calls.find(([sql]) =>
          sql.includes("WITH candidate AS MATERIALIZED"),
        );
        expect(issuance).toBeDefined();
        expect(issuance![1]).toEqual([
          "learner@example.com",
          expect.any(String),
          expect.any(String),
          issuedAt,
          new Date(issuedAt.getTime() + lifetime),
          issuedAt,
          expect.any(String),
          "user-id",
        ]);
        const rateLimitTimes = client.query.mock.calls
          .filter(([sql]) => sql.includes("INSERT INTO auth_rate_limits"))
          .map(([, values]) => values?.[3]);
        expect(rateLimitTimes).toEqual([checkedAt, checkedAt]);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("rejects an unknown reset token before hashing the replacement password", async () => {
    const database = {
      query: vi.fn(async () => ({ rows: [] })),
      connect: vi.fn(),
    } as unknown as Pool;

    await expect(
      resetPassword(database, "unknown-reset-token", "replacement password"),
    ).resolves.toBe(false);

    expect(password.hashPassword).not.toHaveBeenCalled();
    expect(database.connect).not.toHaveBeenCalled();
  });

  it("rechecks a reset link after waiting for the user lock", async () => {
    const checkedAt = new Date("2026-09-27T00:00:00.000Z");
    const exchangedAt = new Date("2026-09-27T00:30:00.000Z");
    const clock = vi
      .fn<() => Date>()
      .mockReturnValueOnce(checkedAt)
      .mockReturnValueOnce(exchangedAt);
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const database = {
      query: vi.fn(async () => ({ rows: [{ userId: "user-id" }] })),
      connect: vi.fn(async () => client),
    } as unknown as Pool;

    await expect(
      exchangePasswordResetToken(database, "reset-link", clock),
    ).resolves.toBeUndefined();

    expect(clock).toHaveBeenCalledTimes(2);
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE auth_tokens"),
      ["user-id", expect.any(String), exchangedAt],
    );
    expect(queries.some((sql) => sql.includes("password_reset_session"))).toBe(
      false,
    );
  });

  it("does not hold a database transaction while verifying a password", async () => {
    const events: string[] = [];
    const queries: string[] = [];
    password.verifyPassword.mockImplementationOnce(async () => {
      events.push("verify");
      return false;
    });
    const client = {
      query: vi.fn(async () => ({ rows: [] })),
      release: vi.fn(),
    };
    const database = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        return { rows: [] };
      }),
      connect: vi.fn(async () => {
        events.push("connect");
        return client;
      }),
    } as unknown as Pool;

    await expect(
      authenticatePassword(database, "missing@example.com", "wrong password"),
    ).resolves.toBeUndefined();

    expect(events).toEqual(["verify"]);
    expect(queries).toHaveLength(1);
    expect(queries[0]).not.toContain("auth_link_sessions");
    expect(queries[0]).not.toContain("FOR UPDATE");
  });

  it.each([
    [1, 2],
    [2, 1],
    [3, 0],
  ])(
    "excludes the initial password reset from the resend quota after %i requests",
    async (attemptCount, remaining) => {
      const now = new Date("2026-10-15T00:00:00.000Z");
      const client = {
        query: vi.fn(async (sql: string) => ({
          rows: sql.includes("INSERT INTO auth_rate_limits")
            ? [{ attemptCount, expiresAt: new Date(now.getTime() + 3_600_000) }]
            : [],
        })),
        release: vi.fn(),
      };
      const database = {
        connect: vi.fn(async () => client),
      } as unknown as Pool;

      await expect(
        requestPasswordReset(
          database,
          "learner@example.com",
          "203.0.113.10",
          {
            authTokenSecret: "a".repeat(32),
            rateLimitSecret: "r".repeat(32),
            resend: true,
          },
          now,
        ),
      ).resolves.toEqual({ limit: 3, remaining, retryAfterSeconds: 3600 });
    },
  );

  it.each([["password reset", requestPasswordReset]] as const)(
    "uses the same database statement sequence for existing and missing %s accounts",
    async (_name, operation) => {
      const run = async (hasUser: boolean) => {
        const queries: string[] = [];
        const client = {
          query: vi.fn(async (sql: string) => {
            queries.push(sql);
            if (sql.includes("INSERT INTO auth_rate_limits")) {
              return { rows: [{ expiresAt: new Date() }] };
            }
            if (sql.includes("SELECT id FROM users WHERE email")) {
              return { rows: hasUser ? [{ id: "user-id" }] : [] };
            }
            return { rows: [] };
          }),
          release: vi.fn(),
        };
        const database = {
          connect: vi.fn(async () => client),
        } as unknown as Pool;

        await operation(
          database,
          "learner@example.com",
          "203.0.113.10",
          {
            authTokenSecret: "a".repeat(32),
            rateLimitSecret: "r".repeat(32),
          },
          new Date("2026-09-29T00:00:00.000Z"),
        );
        return queries;
      };

      const [existing, missing] = await Promise.all([run(true), run(false)]);

      expect(existing).toEqual(missing);
    },
  );
});
