import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

import {
  finishPasswordLoginAttempt,
  hashPasswordLoginSubject,
  withPasswordLoginAttempt,
} from "#api/modules/auth/login-rate-limit";
import { hashRateLimitSubject } from "#api/modules/auth/rate-limit";

describe("password login subject hashing", () => {
  it("returns a committed credential failure without opening an unnecessary release transaction", async () => {
    const now = new Date();
    let pending: string[] = [];
    let connections = 0;
    const client = {
      query: async (sql: string, values?: unknown[]) => {
        if (sql.includes("SELECT clock_timestamp()"))
          return { rows: [{ now }] };
        if (sql.includes("array_append")) pending = [values![1] as string];
        if (sql.includes("array_remove")) pending = [];
        return {
          rows: [
            {
              windowId: "window",
              expiresAt: new Date(now.getTime() + 900_000),
              attemptCount: 0,
              pendingAttempts: pending,
            },
          ],
        };
      },
      release: () => undefined,
    };
    const database = {
      connect: async () => {
        if (++connections > 2)
          throw new Error("unnecessary release unavailable");
        return client;
      },
    } as unknown as Pool;
    await expect(
      withPasswordLoginAttempt(
        database,
        "a@example.test",
        "ip1",
        "r".repeat(32),
        async (attempt) => {
          await finishPasswordLoginAttempt(database, attempt, "failure");
          return { status: "invalid_credentials" };
        },
      ),
    ).resolves.toEqual({ status: "invalid_credentials" });
    expect(connections).toBe(2);
  });
  it("separates policies, subject kinds, secrets and tuple boundaries", () => {
    const secret = "a".repeat(32);
    const pair = hashPasswordLoginSubject(
      "identifier_client_address",
      ["a:b", "c"],
      secret,
    );
    expect(pair).toMatch(/^[0-9a-f]{64}$/);
    expect(pair).toBe(
      hashPasswordLoginSubject(
        "identifier_client_address",
        ["a:b", "c"],
        secret,
      ),
    );
    expect(pair).not.toBe(
      hashPasswordLoginSubject(
        "identifier_client_address",
        ["a", "b:c"],
        secret,
      ),
    );
    expect(pair).not.toBe(
      hashPasswordLoginSubject(
        "identifier_client_address",
        ["a:b", "c"],
        "b".repeat(32),
      ),
    );
    expect(hashPasswordLoginSubject("client_address", ["c"], secret)).not.toBe(
      hashRateLimitSubject("client_address", "c", secret),
    );
    expect(pair).not.toContain("a:b");
  });
});
