import { describe, expect, it, vi } from "vitest";

import { startWorker } from "#backend/worker";
import {
  createWorkerEmailConfig,
  deferred,
  fakeBoss,
  fakeRuntime,
  useWorkerFakeTimers,
} from "#backend-test/support/worker-fixtures";

describe("worker runtime", () => {
  it("reaches graceful stop even while the fresh-mail query is stalled", async () => {
    useWorkerFakeTimers();
    const check = deferred();
    const database = {
      executeSql: vi.fn(async () => {
        await check.promise;
        return { rows: [] };
      }),
    };
    const boss = fakeBoss({ getDb: () => database });
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
    try {
      await vi.advanceTimersByTimeAsync(2_000);
      const stopped = worker.shutdown();
      await Promise.resolve();
      expect(boss.stop).toHaveBeenCalledWith({
        graceful: true,
        timeout: 30_000,
      });
      check.resolve();
      await stopped;
    } finally {
      check.resolve();
      await worker.shutdown();
    }
  });

  it("logs only the first consecutive fresh-mail failure and retries after recovery", async () => {
    useWorkerFakeTimers();
    let broken = true;
    const logError = vi.fn();
    const database = {
      executeSql: vi.fn(async () => {
        if (broken) throw new Error("database unavailable");
        return { rows: [] };
      }),
    };
    const boss = fakeBoss({ getDb: () => database });
    const worker = await startWorker({
      boss,
      connectionString: "postgresql://localhost/amuq",
      emailDelivery: {
        config: createWorkerEmailConfig("a@example.com"),
      },
      runtime: fakeRuntime(),
      verifySchema: async () => {},
      logInfo: vi.fn(),
      logError,
    });
    try {
      await vi.advanceTimersByTimeAsync(6_000);
      expect(logError).toHaveBeenCalledTimes(1);
      broken = false;
      await vi.advanceTimersByTimeAsync(2_000);
      broken = true;
      await vi.advanceTimersByTimeAsync(2_000);
      expect(logError).toHaveBeenCalledTimes(2);
    } finally {
      await worker.shutdown();
    }
  });

  it("wakes fresh mail within two seconds without accumulating wakeups and stops polling on shutdown", async () => {
    useWorkerFakeTimers();
    const database = {
      executeSql: vi.fn(async (sql: string) => ({
        rows: sql.includes("freshMail") ? [{ freshMail: true }] : [],
      })),
    };
    let handler: (() => Promise<unknown>) | undefined;
    const boss = fakeBoss({
      getDb: () => database,
      work: vi.fn(async (_name, registered) => {
        handler = registered;
        return "worker-id";
      }),
    });
    const worker = await startWorker({
      boss,
      connectionString: "postgresql://localhost/amuq",
      emailDelivery: {
        config: createWorkerEmailConfig("AMUQ <account@example.com>"),
        sendEmail: vi.fn(),
      },
      runtime: fakeRuntime(),
      verifySchema: async () => {},
      logInfo: vi.fn(),
      logError: vi.fn(),
    });
    try {
      expect(boss.send).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(boss.send).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(8_000);
      expect(boss.send).toHaveBeenCalledTimes(2);
      await handler?.();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(boss.send).toHaveBeenCalledTimes(3);
      await worker.shutdown();
      const reads = database.executeSql.mock.calls.length;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(database.executeSql).toHaveBeenCalledTimes(reads);
    } finally {
      await worker.shutdown();
    }
  });

  it("registers a scheduled email outbox worker and scans immediately", async () => {
    const database = {
      executeSql: vi.fn(async () => ({ rows: [] })),
    };
    let handler: (() => Promise<unknown>) | undefined;
    const boss = fakeBoss({
      getDb: vi.fn(() => database),
      work: vi.fn(async (_name, registeredHandler) => {
        handler = registeredHandler;
        return "worker-id";
      }),
    });

    const worker = await startWorker({
      boss,
      connectionString: "postgresql://localhost/amuq",
      emailDelivery: {
        config: createWorkerEmailConfig("AMUQ <account@example.com>"),
        sendEmail: vi.fn(),
      },
      logError: vi.fn(),
      runtime: fakeRuntime(),
      verifySchema: vi.fn(async () => undefined),
    });

    expect(boss.createQueue).toHaveBeenCalledWith("send-email");
    expect(boss.work).toHaveBeenCalledWith("send-email", expect.any(Function));
    expect(boss.schedule).toHaveBeenCalledWith("send-email", "* * * * *");
    expect(boss.send).toHaveBeenCalledWith("send-email");
    await handler?.();
    expect(database.executeSql).toHaveBeenCalledWith(
      expect.stringContaining("FROM email_outbox"),
      [expect.any(Date)],
    );

    await worker.shutdown();
  });
});
