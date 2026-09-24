import { readMigrationFiles } from "drizzle-orm/migrator";
import {
  PgBoss,
  type BamStatusSummary,
  type ConstructorOptions,
} from "pg-boss";
import { Pool, type PoolConfig } from "pg";

import { applicationEnvironment } from "../config/environment.ts";
import { migrationConfig } from "./migration-config.ts";

const databaseProbeTimeoutMs = 5_000;

export interface QueryClient {
  query(sql: string, values?: unknown[]): Promise<unknown>;
}

interface MigrationRow {
  rows: { created_at: string; hash: string }[];
}

export function databaseUrl(
  environment: {
    AMUQ_ENV?: string | undefined;
    DATABASE_URL?: string | undefined;
  } = process.env,
): string {
  applicationEnvironment(environment);
  const value = environment.DATABASE_URL;
  if (!value) {
    throw new Error("DATABASE_URL is required");
  }
  return value;
}

export function createDatabasePool(
  connectionString: string,
  queryTimeout = databaseProbeTimeoutMs,
): Pool {
  // ponytail: one connection is enough for foundation probes; size service pools from Railway limits before adding workload.
  return new Pool({
    connectionString,
    connectionTimeoutMillis: databaseProbeTimeoutMs,
    max: 1,
    options: `-c statement_timeout=${queryTimeout} -c lock_timeout=${queryTimeout}`,
    query_timeout: queryTimeout,
  });
}

export async function assertDatabaseSchema(
  connectionString: string,
  client: QueryClient,
): Promise<void> {
  await assertDrizzleSchema(client);
  await assertPgBossSchema(connectionString);
}

export async function assertDrizzleSchema(client: QueryClient): Promise<void> {
  const target = readMigrationFiles(migrationConfig).at(-1);
  if (!target) {
    throw new Error("No Drizzle migration target exists");
  }

  const result = (await client.query(
    'SELECT created_at::text, hash FROM drizzle."__drizzle_migrations" ORDER BY created_at DESC LIMIT 1',
  )) as MigrationRow;

  if (
    result.rows[0]?.created_at !== String(target.folderMillis) ||
    result.rows[0]?.hash !== target.hash
  ) {
    throw new Error("Database schema is not at the target Drizzle version");
  }
}

export async function assertPgBossSchema(
  connectionString: string,
): Promise<void> {
  const boss = new PgBoss({
    ...pgBossDatabaseOptions(connectionString),
    migrate: false,
    schedule: false,
    supervise: false,
  });

  try {
    await boss.start();
    assertPgBossMigrationsComplete(await boss.getBamStatus());
  } finally {
    await boss.stop({ graceful: false });
  }
}

export function pgBossDatabaseOptions(
  connectionString: string,
  queryTimeout = databaseProbeTimeoutMs,
) {
  return {
    connectionString,
    connectionTimeoutMillis: databaseProbeTimeoutMs,
    max: 1,
    options: `-c statement_timeout=${queryTimeout} -c lock_timeout=${queryTimeout}`,
    query_timeout: queryTimeout,
  } satisfies ConstructorOptions & Pick<PoolConfig, "query_timeout">;
}

export function assertPgBossMigrationsComplete(
  statuses: BamStatusSummary[],
): void {
  const incomplete = statuses.find(
    ({ count, status }) => count > 0 && status !== "completed",
  );

  if (!incomplete) return;
  if (incomplete.status === "failed") {
    throw new Error("pg-boss background migration failed");
  }
  throw new Error("pg-boss background migration is not complete");
}
