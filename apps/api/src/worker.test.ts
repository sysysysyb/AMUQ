import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";

import { DatabaseError } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  startWorker,
  type WorkerBoss,
  workerDatabaseOptions,
} from "#api/worker";

const fakeRuntime = () => {
  return Object.assign(new EventEmitter(), {
    exitCode: undefined,
  });
};

const fakeBoss = (overrides: Partial<WorkerBoss> = {}): WorkerBoss => {
  return {
    createQueue: vi.fn(async () => undefined),
    getDb: vi.fn(() => ({ executeSql: vi.fn(async () => ({ rows: [] })) })),
    on: vi.fn(),
    schedule: vi.fn(async () => undefined),
    send: vi.fn(async () => "job-id"),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    work: vi.fn(async () => "worker-id"),
    ...overrides,
  };
};

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("worker runtime", () => {
  it("reaches graceful stop even while the fresh-mail query is stalled", async () => {
    vi.useFakeTimers();
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
        config: {
          apiKey: "re_test",
          authTokenSecret: "a".repeat(32),
          from: "a@example.com",
          webOrigin: "https://example.com",
        },
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
      vi.useRealTimers();
    }
  });

  it("logs only the first consecutive fresh-mail failure and retries after recovery", async () => {
    vi.useFakeTimers();
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
        config: {
          apiKey: "re_test",
          authTokenSecret: "a".repeat(32),
          from: "a@example.com",
          webOrigin: "https://example.com",
        },
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
      vi.useRealTimers();
    }
  });

  it("runs signup cleanup at most once per minute across fresh-mail wakeups", async () => {
    vi.useFakeTimers();
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
        config: {
          apiKey: "re_test",
          authTokenSecret: "a".repeat(32),
          from: "a@example.com",
          webOrigin: "https://example.com",
        },
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
      vi.useRealTimers();
    }
  });

  it("wakes fresh mail within two seconds without accumulating wakeups and stops polling on shutdown", async () => {
    vi.useFakeTimers();
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
        config: {
          apiKey: "re_test",
          authTokenSecret: "a".repeat(32),
          from: "AMUQ <account@example.com>",
          webOrigin: "https://example.com",
        },
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
      vi.useRealTimers();
    }
  });

  it("loads TypeScript source in Node strip-only mode", () => {
    execFileSync(
      process.execPath,
      [
        "--conditions=development",
        "--experimental-strip-types",
        "--input-type=module",
        "--eval",
        'await import("#api/worker");',
      ],
      { cwd: new URL("../", import.meta.url), timeout: 10_000 },
    );
  });

  it("uses one non-migrating pg-boss connection", () => {
    expect(workerDatabaseOptions("postgresql://localhost/amuq")).toMatchObject({
      application_name: "amuq-worker",
      max: 1,
      migrate: false,
    });
  });

  it("verifies the database before starting the worker", async () => {
    const events: string[] = [];
    const boss = fakeBoss({
      start: vi.fn(async () => {
        events.push("start");
      }),
    });
    const runtime = fakeRuntime();
    const once = vi.spyOn(runtime, "once");

    const worker = await startWorker({
      boss,
      connectionString: "postgresql://localhost/amuq",
      logError: vi.fn(),
      logInfo: () => events.push("ready"),
      runtime,
      verifySchema: async () => {
        events.push("verify");
      },
    });

    expect(events).toEqual(["verify", "start", "ready"]);
    expect(once).toHaveBeenCalledTimes(2);
    await worker.shutdown();
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
        config: {
          apiKey: "re_test",
          authTokenSecret: "a".repeat(32),
          from: "AMUQ <account@example.com>",
          webOrigin: "https://example.com",
        },
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

  it("stops pg-boss when email worker registration fails after startup", async () => {
    const registrationError = new Error("queue registration failed");
    const boss = fakeBoss({
      createQueue: vi.fn(async () => Promise.reject(registrationError)),
    });
    const runtime = fakeRuntime();

    await expect(
      startWorker({
        boss,
        connectionString: "postgresql://localhost/amuq",
        emailDelivery: {
          config: {
            apiKey: "re_test",
            authTokenSecret: "a".repeat(32),
            from: "AMUQ <account@example.com>",
            webOrigin: "https://example.com",
          },
        },
        logError: vi.fn(),
        runtime,
        verifySchema: vi.fn(async () => undefined),
      }),
    ).rejects.toThrow(registrationError);

    expect(boss.stop).toHaveBeenCalledWith({ graceful: false });
    expect(runtime.listenerCount("SIGINT")).toBe(0);
    expect(runtime.listenerCount("SIGTERM")).toBe(0);
  });

  it.each(["55P03", "EPIPE"])(
    "keeps delivery running with bounded cleanup diagnostics for %s",
    async (errorCode) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(200_000);
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
          config: {
            apiKey: "re_test",
            authTokenSecret: "a".repeat(32),
            from: "AMUQ <account@example.com>",
            webOrigin: "https://example.com",
          },
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
        clock.mockRestore();
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
        config: {
          apiKey: "re_test",
          authTokenSecret: "a".repeat(32),
          from: "AMUQ <account@example.com>",
          webOrigin: "https://example.com",
        },
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

  it("cleans up startup signals when schema verification fails", async () => {
    const boss = fakeBoss();
    const runtime = fakeRuntime();
    const once = vi.spyOn(runtime, "once");

    await expect(
      startWorker({
        boss,
        connectionString: "postgresql://localhost/amuq",
        logError: vi.fn(),
        runtime,
        verifySchema: async () => {
          throw new Error("schema drift");
        },
      }),
    ).rejects.toThrow("schema drift");

    expect(boss.start).not.toHaveBeenCalled();
    expect(once).toHaveBeenCalledTimes(2);
    expect(runtime.listenerCount("SIGINT")).toBe(0);
    expect(runtime.listenerCount("SIGTERM")).toBe(0);
  });

  it("does not start when shutdown is requested during schema verification", async () => {
    const verification = deferred();
    const boss = fakeBoss();
    const logInfo = vi.fn();
    const runtime = fakeRuntime();
    const starting = startWorker({
      boss,
      connectionString: "postgresql://localhost/amuq",
      logError: vi.fn(),
      logInfo,
      runtime,
      verifySchema: () => verification.promise,
    });

    runtime.emit("SIGTERM");
    verification.resolve();
    const worker = await starting;
    await worker.shutdown();

    expect(boss.start).not.toHaveBeenCalled();
    expect(boss.stop).not.toHaveBeenCalled();
    expect(logInfo).not.toHaveBeenCalled();
    expect(runtime.listenerCount("SIGINT")).toBe(0);
    expect(runtime.listenerCount("SIGTERM")).toBe(0);
  });

  it("stops after shutdown is requested while the worker is starting", async () => {
    const startup = deferred();
    const boss = fakeBoss({ start: vi.fn(() => startup.promise) });
    const logInfo = vi.fn();
    const runtime = fakeRuntime();
    const starting = startWorker({
      boss,
      connectionString: "postgresql://localhost/amuq",
      logError: vi.fn(),
      logInfo,
      runtime,
      verifySchema: vi.fn(async () => undefined),
    });

    await vi.waitFor(() => expect(boss.start).toHaveBeenCalledOnce());
    runtime.emit("SIGINT");
    startup.resolve();
    const worker = await starting;
    await worker.shutdown();

    expect(boss.stop).toHaveBeenCalledOnce();
    expect(logInfo).not.toHaveBeenCalled();
    expect(runtime.listenerCount("SIGINT")).toBe(0);
    expect(runtime.listenerCount("SIGTERM")).toBe(0);
  });

  it("stops gracefully once when both shutdown signals arrive", async () => {
    const stopping = deferred();
    const boss = fakeBoss({ stop: vi.fn(() => stopping.promise) });
    const runtime = fakeRuntime();
    const worker = await startWorker({
      boss,
      connectionString: "postgresql://localhost/amuq",
      logError: vi.fn(),
      runtime,
      verifySchema: vi.fn(async () => undefined),
    });

    runtime.emit("SIGTERM");
    runtime.emit("SIGINT");
    let completed = 0;
    const shutdown = async () => {
      await worker.shutdown();
      completed += 1;
    };
    const first = shutdown();
    const second = shutdown();

    await Promise.resolve();
    expect(completed).toBe(0);
    stopping.resolve();
    await Promise.all([first, second]);
    expect(completed).toBe(2);

    expect(boss.stop).toHaveBeenCalledOnce();
    expect(boss.stop).toHaveBeenCalledWith({
      graceful: true,
      timeout: 30_000,
    });
  });

  it("marks shutdown failures for a non-zero process exit", async () => {
    const error = new Error("stop failed");
    const boss = fakeBoss({ stop: vi.fn(async () => Promise.reject(error)) });
    const logError = vi.fn();
    const runtime = fakeRuntime();
    const worker = await startWorker({
      boss,
      connectionString: "postgresql://localhost/amuq",
      logError,
      runtime,
      verifySchema: vi.fn(async () => undefined),
    });

    await worker.shutdown();

    expect(logError).toHaveBeenCalledWith(error);
    expect(runtime.exitCode).toBe(1);
  });
});
