import { pathToFileURL } from "node:url";

import { PgBoss, type ConstructorOptions, type StopOptions } from "pg-boss";

import {
  assertDrizzleSchema,
  assertPgBossSchema,
  createDatabasePool,
  databaseUrl,
  pgBossDatabaseOptions,
} from "./db/database.ts";

const workerShutdownTimeoutMs = 30_000;

export interface WorkerRuntime {
  exitCode: string | number | null | undefined;
  once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface WorkerBoss {
  on(event: "error", listener: (error: Error) => void): unknown;
  start(): Promise<unknown>;
  stop(options: StopOptions): Promise<void>;
}

interface StartWorkerOptions {
  connectionString: string;
  boss?: WorkerBoss;
  logError?: (error: unknown) => void;
  logInfo?: (message: string) => void;
  runtime?: WorkerRuntime;
  verifySchema?: () => Promise<void>;
}

export function workerDatabaseOptions(
  connectionString: string,
): ConstructorOptions {
  return {
    ...pgBossDatabaseOptions(connectionString),
    application_name: "amuq-worker",
    migrate: false,
  };
}

export async function startWorker(options: StartWorkerOptions) {
  const boss =
    options.boss ?? new PgBoss(workerDatabaseOptions(options.connectionString));
  const logError =
    options.logError ?? ((error: unknown) => console.error(error));
  const logInfo =
    options.logInfo ?? ((message: string) => console.info(message));
  const runtime = options.runtime ?? process;

  let stopping: Promise<void> | undefined;
  let shutdownRequested = false;
  let started = false;
  const cleanupSignals = () => {
    runtime.removeListener("SIGINT", onSignal);
    runtime.removeListener("SIGTERM", onSignal);
  };
  const shutdown = async () => {
    shutdownRequested = true;
    cleanupSignals();
    if (!started) return;
    stopping ??= boss
      .stop({ graceful: true, timeout: workerShutdownTimeoutMs })
      .catch((error: unknown) => {
        logError(error);
        runtime.exitCode = 1;
      });
    await stopping;
  };
  const onSignal = () => void shutdown();

  runtime.once("SIGINT", onSignal);
  runtime.once("SIGTERM", onSignal);

  try {
    await (
      options.verifySchema ??
      (() => verifyWorkerSchema(options.connectionString))
    )();
    if (shutdownRequested) return { shutdown };

    boss.on("error", logError);
    await boss.start();
    started = true;
    if (shutdownRequested) {
      await shutdown();
    } else {
      logInfo("AMUQ_WORKER_READY");
    }
  } catch (error) {
    cleanupSignals();
    throw error;
  }

  return { shutdown };
}

async function verifyWorkerSchema(connectionString: string): Promise<void> {
  const pool = createDatabasePool(connectionString);
  try {
    await assertDrizzleSchema(pool);
  } finally {
    await pool.end();
  }
  await assertPgBossSchema(connectionString);
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  await startWorker({ connectionString: databaseUrl() });
}
