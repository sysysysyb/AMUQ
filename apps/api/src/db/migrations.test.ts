import { describe, expect, it, vi } from "vitest";

import { assertPgBossMigrationsComplete } from "#api/db/database";
import { runMigrationSteps, waitForPgBossMigrations } from "#api/db/migrations";

describe("database migrations", () => {
  it("runs Drizzle before pg-boss while holding the advisory lock", async () => {
    const events: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        events.push(sql.includes("unlock") ? "unlock" : "lock");
      }),
    };

    await runMigrationSteps(
      client,
      async () => events.push("drizzle"),
      async () => events.push("pg-boss"),
      async () => events.push("verify"),
    );

    expect(events).toEqual(["lock", "drizzle", "pg-boss", "verify", "unlock"]);
  });

  it("releases the advisory lock when a migration fails", async () => {
    const events: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        events.push(sql.includes("unlock") ? "unlock" : "lock");
      }),
    };

    await expect(
      runMigrationSteps(
        client,
        async () => {
          events.push("drizzle");
          throw new Error("migration failed");
        },
        async () => events.push("pg-boss"),
        async () => events.push("verify"),
      ),
    ).rejects.toThrow("migration failed");

    expect(events).toEqual(["lock", "drizzle", "unlock"]);
  });

  it("waits until pg-boss background migrations finish", async () => {
    const boss = {
      getBamStatus: vi
        .fn()
        .mockResolvedValueOnce([
          { status: "pending", count: 1, lastCreatedOn: new Date() },
        ])
        .mockResolvedValueOnce([
          { status: "completed", count: 1, lastCreatedOn: new Date() },
        ]),
      isBamWorking: vi.fn(() => false),
    };
    const pause = vi.fn(async () => undefined);

    await waitForPgBossMigrations(boss, pause);

    expect(boss.getBamStatus).toHaveBeenCalledTimes(2);
    expect(pause).toHaveBeenCalledOnce();
  });

  it("rejects failed pg-boss background migrations", () => {
    expect(() =>
      assertPgBossMigrationsComplete([
        { status: "failed", count: 1, lastCreatedOn: new Date() },
      ]),
    ).toThrow("pg-boss background migration failed");
  });

  it("times out when a pg-boss status query never settles", async () => {
    vi.useFakeTimers();
    const boss = {
      getBamStatus: vi.fn(() => new Promise<never>(() => undefined)),
      isBamWorking: vi.fn(() => false),
    };

    const result = expect(
      waitForPgBossMigrations(boss, async () => undefined, 1_000),
    ).rejects.toThrow("pg-boss background migration timed out");
    await vi.advanceTimersByTimeAsync(1_000);
    await result;
    vi.useRealTimers();
  });
});
