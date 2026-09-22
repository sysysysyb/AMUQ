import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getRollbackPlans } from "pg-boss";

import {
  assertDatabaseSchema,
  createDatabasePool,
} from "../../src/db/database.js";
import { migrateDatabase } from "../../src/db/migrations.js";
import { assertTestDatabaseUrl } from "../support/test-database.js";

const connectionString = process.env.TEST_DATABASE_URL
  ? assertTestDatabaseUrl(process.env.TEST_DATABASE_URL)
  : undefined;
const databaseTest = connectionString ? describe : describe.skip;
const admin = connectionString
  ? createDatabasePool(connectionString)
  : undefined;

databaseTest("database deployment", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await resetDatabase();
    await admin?.end();
  });

  it("migrates an empty database to the target schemas", async () => {
    await migrateDatabase(connectionString!);

    const pool = createDatabasePool(connectionString!);
    try {
      await expect(
        assertDatabaseSchema(connectionString!, pool),
      ).resolves.toBeUndefined();
    } finally {
      await pool.end();
    }
  });

  it("serializes concurrent migration entrypoints", async () => {
    await Promise.all([
      migrateDatabase(connectionString!),
      migrateDatabase(connectionString!),
    ]);

    const drizzle = await admin!.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM drizzle."__drizzle_migrations"',
    );
    const pgBoss = await admin!.query<{ version: number }>(
      "SELECT version FROM pgboss.version",
    );

    expect(drizzle.rows).toEqual([{ count: "1" }]);
    expect(pgBoss.rows).toHaveLength(1);
    expect(pgBoss.rows[0]?.version).toBeGreaterThan(0);
  });

  it("rejects a Drizzle migration whose recorded hash is stale", async () => {
    await migrateDatabase(connectionString!);
    await admin!.query('UPDATE drizzle."__drizzle_migrations" SET hash = $1', [
      "tampered",
    ]);

    await expect(
      assertDatabaseSchema(connectionString!, admin!),
    ).rejects.toThrow("Database schema is not at the target Drizzle version");
  });

  it("finishes pg-boss background work when upgrading an older schema", async () => {
    await migrateDatabase(connectionString!);

    let version = await pgBossVersion();
    while (version > 37) {
      await admin!.query(getRollbackPlans("pgboss", version));
      version = await pgBossVersion();
    }

    await expect(
      assertDatabaseSchema(connectionString!, admin!),
    ).rejects.toThrow();
    expect(await pgBossVersion()).toBe(37);

    await migrateDatabase(connectionString!);

    const incomplete = await admin!.query<{ status: string }>(
      "SELECT status FROM pgboss.bam WHERE status <> 'completed'",
    );
    expect(incomplete.rows).toEqual([]);
  }, 60_000);
});

async function resetDatabase() {
  await admin?.query("DROP SCHEMA IF EXISTS pgboss CASCADE");
  await admin?.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
}

async function pgBossVersion(): Promise<number> {
  const result = await admin!.query<{ version: number }>(
    "SELECT version FROM pgboss.version",
  );
  return result.rows[0]!.version;
}
