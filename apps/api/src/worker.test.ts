import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  startWorker,
  workerDatabaseOptions,
  type WorkerBoss,
} from "./worker.js";

function fakeRuntime() {
  return Object.assign(new EventEmitter(), {
    exitCode: undefined,
  });
}

function fakeBoss(overrides: Partial<WorkerBoss> = {}): WorkerBoss {
  return {
    on: vi.fn(),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    ...overrides,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("worker runtime", () => {
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
    const boss = fakeBoss();
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
    await worker.shutdown();

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
