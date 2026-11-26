import { EventEmitter } from "node:events";

import { onTestFinished, vi } from "vitest";

import type { WorkerBoss } from "#backend/worker";

export const fakeRuntime = () => {
  return Object.assign(new EventEmitter(), {
    exitCode: undefined,
  });
};

export const fakeBoss = (overrides: Partial<WorkerBoss> = {}): WorkerBoss => {
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

export const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

export const createWorkerEmailConfig = (from: string) => ({
  apiKey: "re_test",
  authTokenSecret: "a".repeat(32),
  from,
  webOrigin: "https://example.com",
});

export const useWorkerFakeTimers = () => {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
};
