import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { PgBoss } from "pg-boss";

import {
  assertPgBossMigrationsComplete,
  assertDatabaseSchema,
  createDatabasePool,
  pgBossDatabaseOptions,
  type QueryClient,
} from "./database.ts";
import { migrationConfig } from "./migration-config.ts";

const migrationLockName = "amuq:migrations";
const migrationTimeoutMs = 15 * 60 * 1_000;

export async function runMigrationSteps(
  client: QueryClient,
  migrateDrizzle: () => Promise<unknown>,
  migratePgBoss: () => Promise<unknown>,
  verify: () => Promise<unknown>,
): Promise<void> {
  await client.query("SELECT pg_advisory_lock(hashtext($1))", [
    migrationLockName,
  ]);

  try {
    await migrateDrizzle();
    await migratePgBoss();
    await verify();
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", [
      migrationLockName,
    ]);
  }
}

export async function migrateDatabase(connectionString: string): Promise<void> {
  const pool = createDatabasePool(connectionString, migrationTimeoutMs);
  const client = await pool.connect();

  try {
    await runMigrationSteps(
      client,
      async () => migrate(drizzle(client), migrationConfig),
      async () => migratePgBossSchema(connectionString),
      async () => assertDatabaseSchema(connectionString, client),
    );
  } finally {
    client.release();
    await pool.end();
  }
}

async function migratePgBossSchema(connectionString: string): Promise<void> {
  const boss = new PgBoss({
    ...pgBossDatabaseOptions(connectionString, migrationTimeoutMs),
    bamIntervalSeconds: 10,
    migrate: true,
    schedule: false,
    supervise: false,
  });
  let migrationError: Error | undefined;
  boss.on("error", (error) => {
    migrationError = error;
  });

  try {
    await boss.start();
    await waitForPgBossMigrations(boss);
    if (migrationError) throw migrationError;
  } finally {
    await boss.stop({ graceful: false });
  }
}

type PgBossMigrationProbe = Pick<PgBoss, "getBamStatus" | "isBamWorking">;

export async function waitForPgBossMigrations(
  boss: PgBossMigrationProbe,
  pause: () => Promise<void> = async () =>
    new Promise((resolve) => setTimeout(resolve, 100)),
  timeoutMs = migrationTimeoutMs,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout>;
  const timedOut = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error("pg-boss background migration timed out")),
      timeoutMs,
    );
  });

  try {
    while (true) {
      const statuses = await Promise.race([boss.getBamStatus(), timedOut]);
      const failed = statuses.some(
        ({ count, status }) => count > 0 && status === "failed",
      );
      if (failed) assertPgBossMigrationsComplete(statuses);

      const pending = statuses.some(
        ({ count, status }) =>
          count > 0 && (status === "pending" || status === "in_progress"),
      );
      if (!pending && !boss.isBamWorking()) return;
      await Promise.race([pause(), timedOut]);
    }
  } finally {
    clearTimeout(timeout!);
  }
}
