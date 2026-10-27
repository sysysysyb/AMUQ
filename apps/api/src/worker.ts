import { pathToFileURL } from "node:url";
import {
  type ConstructorOptions,
  type Db,
  PgBoss,
  type StopOptions,
  type WorkHandler,
} from "pg-boss";
import {
  assertDrizzleSchema,
  assertPgBossSchema,
  createDatabasePool,
  databaseUrl,
  pgBossDatabaseOptions,
} from "#api/db/database";
import {
  deliverPendingEmails,
  type EmailDeliveryConfig,
  emailDeliveryConfig,
  sendEmailQueue,
} from "#api/jobs/send-email";
import {
  type ResendEmail,
  type ResendEmailResult,
  sendResendEmail,
} from "#api/modules/email/resend";

const workerShutdownTimeoutMs = 30_000;

export interface WorkerRuntime {
  exitCode: string | number | null | undefined;
  once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface WorkerBoss {
  createQueue(name: string): Promise<void>;
  getDb(): Db;
  on(event: "error", listener: (error: Error) => void): unknown;
  schedule(name: string, cron: string): Promise<void>;
  send(name: string): Promise<string | null>;
  start(): Promise<unknown>;
  stop(options: StopOptions): Promise<void>;
  work(name: string, handler: WorkHandler<object, unknown>): Promise<string>;
}

interface EmailDeliveryRuntime {
  config: EmailDeliveryConfig;
  sendEmail?(email: ResendEmail): Promise<ResendEmailResult>;
}

interface StartWorkerOptions {
  connectionString: string;
  boss?: WorkerBoss;
  emailDelivery?: EmailDeliveryRuntime;
  logError?: (error: unknown) => void;
  logInfo?: (message: string) => void;
  runtime?: WorkerRuntime;
  verifySchema?: () => Promise<void>;
}

export const workerDatabaseOptions = (
  connectionString: string,
): ConstructorOptions => {
  return {
    ...pgBossDatabaseOptions(connectionString),
    application_name: "amuq-worker",
    migrate: false,
  };
};

export const startWorker = async (options: StartWorkerOptions) => {
  const boss: WorkerBoss =
    options.boss ?? new PgBoss(workerDatabaseOptions(options.connectionString));
  const logError =
    options.logError ?? ((error: unknown) => console.error(error));
  const logInfo =
    options.logInfo ?? ((message: string) => console.info(message));
  const runtime = options.runtime ?? process;

  let stopping: Promise<void> | undefined;
  let shutdownRequested = false;
  let started = false;
  let freshMailTimer: ReturnType<typeof setInterval> | undefined;
  let freshMailCheck: Promise<void> | undefined;
  let mailWakeupQueued = false;
  let freshMailFailureLogged = false;
  const cleanupSignals = () => {
    runtime.removeListener("SIGINT", onSignal);
    runtime.removeListener("SIGTERM", onSignal);
  };
  const stop = async () => {
    try {
      await boss.stop({ graceful: true, timeout: workerShutdownTimeoutMs });
    } catch (error) {
      logError(error);
      runtime.exitCode = 1;
    }
  };
  const shutdown = async () => {
    shutdownRequested = true;
    clearInterval(freshMailTimer);
    cleanupSignals();
    if (!started) return;
    stopping ??= stop();
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
    if (options.emailDelivery) {
      const { config } = options.emailDelivery;
      const sendEmail =
        options.emailDelivery.sendEmail ??
        ((email: ResendEmail) =>
          sendResendEmail(email, { apiKey: config.apiKey }));
      await boss.createQueue(sendEmailQueue);
      await boss.work(sendEmailQueue, async () => {
        mailWakeupQueued = false;

        await deliverPendingEmails(boss.getDb(), {
          ...(config.authTokenPreviousSecret
            ? { authTokenPreviousSecret: config.authTokenPreviousSecret }
            : {}),
          authTokenSecret: config.authTokenSecret,
          from: config.from,
          sendEmail,
          webOrigin: config.webOrigin,
        });
      });
      await boss.schedule(sendEmailQueue, "* * * * *");
      await boss.send(sendEmailQueue);
      freshMailTimer = setInterval(() => {
        if (shutdownRequested || freshMailCheck || mailWakeupQueued) return;
        freshMailCheck = (async () => {
          try {
            const { rows } = await boss.getDb().executeSql(`SELECT EXISTS (
            SELECT 1 FROM email_outbox WHERE status = 'pending' AND attempt_count = 0
          ) AS "freshMail"`);
            if (
              !shutdownRequested &&
              (rows[0] as { freshMail?: boolean } | undefined)?.freshMail
            ) {
              mailWakeupQueued = true;
              try {
                await boss.send(sendEmailQueue);
              } catch (error) {
                mailWakeupQueued = false;
                throw error;
              }
            }
            freshMailFailureLogged = false;
          } catch (error) {
            if (!freshMailFailureLogged) {
              freshMailFailureLogged = true;
              logError(error);
            }
          } finally {
            freshMailCheck = undefined;
          }
        })();
      }, 2_000);
      freshMailTimer.unref();
    }
    if (shutdownRequested) {
      await shutdown();
    } else {
      logInfo("AMUQ_WORKER_READY");
    }
  } catch (error) {
    clearInterval(freshMailTimer);
    cleanupSignals();
    if (started) {
      if (stopping) {
        await stopping;
      } else {
        try {
          await boss.stop({ graceful: false });
        } catch (stopError) {
          logError(stopError);
          runtime.exitCode = 1;
        }
      }
    }
    throw error;
  }

  return { shutdown };
};

const verifyWorkerSchema = async (connectionString: string): Promise<void> => {
  const pool = createDatabasePool(connectionString);
  try {
    await assertDrizzleSchema(pool);
  } finally {
    await pool.end();
  }
  await assertPgBossSchema(connectionString);
};

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  await startWorker({
    connectionString: databaseUrl(),
    emailDelivery: { config: emailDeliveryConfig() },
  });
}
