import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getRollbackPlans, PgBoss } from "pg-boss";

import {
  assertDatabaseSchema,
  createDatabasePool,
} from "../../src/db/database.js";
import { migrateDatabase } from "../../src/db/migrations.js";
import { startWorker, workerDatabaseOptions } from "../../src/worker.js";
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

  it("bounds the wait when the API database pool is exhausted", async () => {
    const pool = createDatabasePool(connectionString!);
    const client = await pool.connect();

    try {
      await expect(pool.query("SELECT 1")).rejects.toThrow(
        "timeout exceeded when trying to connect",
      );
    } finally {
      client.release();
      await pool.end();
    }
  }, 10_000);

  it("processes queue polling load within the one-connection worker budget", async () => {
    await migrateDatabase(connectionString!);
    const boss = new PgBoss(workerDatabaseOptions(connectionString!));
    const queue = "foundation-load";
    const jobCount = 20;
    let processed = 0;
    try {
      await boss.start();
      await boss.createQueue(queue);
      await boss.work(
        queue,
        {
          batchSize: 5,
          localConcurrency: 1,
          pollingIntervalSeconds: 0.5,
        },
        async (jobs) => {
          processed += jobs.length;
        },
      );
      await Promise.all(
        Array.from({ length: jobCount }, (_, sequence) =>
          boss.send(queue, { sequence }),
        ),
      );

      await vi.waitFor(() => expect(processed).toBe(jobCount), {
        timeout: 15_000,
      });
      expect(processed).toBe(jobCount);
    } finally {
      await boss.stop({ graceful: true, timeout: 5_000 });
    }
  }, 30_000);

  it("starts the real worker with a one-connection database role", async () => {
    await migrateDatabase(connectionString!);
    const role = "amuq_worker_connection_limit";
    const password = randomUUID();
    const workerUrl = new URL(connectionString!);
    workerUrl.username = role;
    workerUrl.password = password;
    await admin!.query(`DROP ROLE IF EXISTS ${role}`);
    await admin!.query(
      `CREATE ROLE ${role} LOGIN CONNECTION LIMIT 1 PASSWORD '${password}'`,
    );

    try {
      const owner = await admin!.query<{ name: string }>(
        "SELECT quote_ident(current_user) AS name",
      );
      await admin!.query(`GRANT ${owner.rows[0]!.name} TO ${role}`);
      const worker = await startWorker({
        connectionString: workerUrl.href,
        logInfo: vi.fn(),
      });
      await worker.shutdown();
    } finally {
      await admin!.query(`DROP ROLE ${role}`);
    }
  }, 30_000);
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
