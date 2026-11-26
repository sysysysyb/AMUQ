import { DatabaseError } from "pg";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { startWorker } from "#backend/worker";
import {
  createWorkerEmailConfig,
  fakeBoss,
  fakeRuntime,
  useWorkerFakeTimers,
} from "#backend-test/support/worker-fixtures";

describe("worker runtime", () => {
  it("runs signup cleanup at most once per minute across fresh-mail wakeups", async () => {
    useWorkerFakeTimers();
    let handler: (() => Promise<unknown>) | undefined;
    const database = {
      executeSql: vi.fn<(sql: string) => Promise<{ rows: unknown[] }>>(
        async () => ({ rows: [] }),
      ),
    };
    const boss = fakeBoss({
      getDb: () => database,
      work: vi.fn(async (_name, registered) => {
        handler = registered;
        return "id";
      }),
    });
    const worker = await startWorker({
      boss,
      connectionString: "postgresql://localhost/amuq",
      emailDelivery: {
        config: createWorkerEmailConfig("a@example.com"),
      },
      runtime: fakeRuntime(),
      verifySchema: async () => {},
      logInfo: vi.fn(),
      logError: vi.fn(),
    });
    const cleanupCount = () =>
      database.executeSql.mock.calls.filter(([sql]) =>
        String(sql).includes("DELETE FROM auth_signup_attempts"),
      ).length;
    try {
      await handler?.();
      await handler?.();
      expect(cleanupCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(60_000);
      await handler?.();
      expect(cleanupCount()).toBe(2);
    } finally {
      await worker.shutdown();
    }
  });

  it.each(["55P03", "EPIPE"])(
    "keeps delivery running with bounded cleanup diagnostics for %s",
    async (errorCode) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(200_000);
      onTestFinished(() => {
        clock.mockRestore();
      });
      const database = {
        executeSql: vi.fn(async (sql: string) => {
          if (sql.includes("DELETE FROM auth_signup_attempts"))
            throw Object.assign(
              errorCode === "55P03"
                ? new DatabaseError("private cleanup detail", 0, "error")
                : new Error("private cleanup detail"),
              {
                code: errorCode,
              },
            );
          return { rows: [] };
        }),
      };
      let handler: (() => Promise<unknown>) | undefined;
      const boss = fakeBoss({
        getDb: () => database,
        work: vi.fn(async (_name, registered) => {
          handler = registered;
          return "worker-id";
        }),
      });
      const logError = vi.fn();
      const worker = await startWorker({
        boss,
        connectionString: "postgresql://localhost/amuq",
        emailDelivery: {
          config: createWorkerEmailConfig("AMUQ <account@example.com>"),
          sendEmail: vi.fn(),
        },
        logError,
        logInfo: vi.fn(),
        runtime: fakeRuntime(),
        verifySchema: vi.fn(async () => undefined),
      });
      try {
        await expect(handler!()).resolves.toBeUndefined();
        clock.mockReturnValue(260_000);
        await expect(handler!()).resolves.toBeUndefined();
        expect(logError).toHaveBeenCalledTimes(2);
        expect(logError).toHaveBeenCalledWith({
          code: "signup_cleanup_failed",
          sqlState: errorCode === "55P03" ? errorCode : "unknown",
        });
        expect(JSON.stringify(logError.mock.calls)).not.toContain(
          "private cleanup detail",
        );
        expect(
          database.executeSql.mock.calls.filter(([sql]) =>
            sql.includes("SELECT * FROM claimed"),
          ),
        ).toHaveLength(2);
      } finally {
        await worker.shutdown();
      }
    },
  );

  it("runs signup cleanup even when delivery fails and preserves the delivery error", async () => {
    const failure = new Error("delivery failure");
    const database = {
      executeSql: vi.fn(async (sql: string) => {
        if (sql.includes("WITH consumed")) throw failure;
        return { rows: [] };
      }),
    };
    let handler: (() => Promise<unknown>) | undefined;
    const worker = await startWorker({
      boss: fakeBoss({
        getDb: () => database,
        work: vi.fn(async (_name, registered) => {
          handler = registered;
          return "worker-id";
        }),
      }),
      connectionString: "postgresql://localhost/amuq",
      emailDelivery: {
        config: createWorkerEmailConfig("AMUQ <account@example.com>"),
        sendEmail: vi.fn(),
      },
      logError: vi.fn(),
      logInfo: vi.fn(),
      runtime: fakeRuntime(),
      verifySchema: vi.fn(async () => undefined),
    });
    try {
      await expect(handler!()).rejects.toBe(failure);
      expect(
        database.executeSql.mock.calls.some(([sql]) =>
          sql.includes("DELETE FROM auth_signup_attempts"),
        ),
      ).toBe(true);
    } finally {
      await worker.shutdown();
    }
  });
});
