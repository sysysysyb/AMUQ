import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withPasswordLoginAttempt } from "#api/modules/auth/login-rate-limit";
import { authenticatePassword } from "#api/modules/auth/service";

const password = vi.hoisted(() => ({
  hashPassword: vi.fn(async () => "hashed-password"),
  verifyPassword: vi.fn(async () => false),
}));

vi.mock("#api/modules/auth/password", () => password);

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
});
