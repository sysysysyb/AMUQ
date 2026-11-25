import { readMigrationFiles } from "drizzle-orm/migrator";
import { getRollbackPlans } from "pg-boss";
import { expect, it } from "vitest";

import { assertDatabaseSchema, createDatabasePool } from "#backend/db/database";
import { migrationConfig } from "#backend/db/migration-config";
import { migrateDatabase } from "#backend/db/migrations";
import { createTestDatabase } from "#backend-test/support/database-fixture";

const { admin, connectionString, databaseTest } = createTestDatabase("suite");

const pgBossVersion = async (): Promise<number> => {
  const result = await admin!.query<{ version: number }>(
    "SELECT version FROM pgboss.version",
  );
  return result.rows[0]!.version;
};

databaseTest("database deployment", () => {
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

  it.each(["0006", "previous"] as const)(
    "upgrades the %s schema without changing existing email delivery",
    async (baseline) => {
      const migrations = readMigrationFiles(migrationConfig);
      await admin!.query(`CREATE SCHEMA drizzle;
      CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)`);
      const startingMigrations =
        baseline === "0006" ? migrations.slice(0, 7) : migrations.slice(0, -1);
      for (const migration of startingMigrations) {
        for (const statement of migration.sql) {
          if (statement.trim()) await admin!.query(statement);
        }
        await admin!.query(
          "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
          [migration.hash, migration.folderMillis],
        );
      }
      await admin!.query(`WITH owner AS (
      INSERT INTO users (email) VALUES ('migration-fixture@example.com') RETURNING id
    ), token AS (
      INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at)
      SELECT id, 'email_verification', repeat('a', 64), now() + interval '24 hours' FROM owner RETURNING id
    ) INSERT INTO email_outbox (token_id, status, provider_message_id, token_key_id)
      SELECT id, 'sent', 'previous-message', repeat('b', 16) FROM token`);
      const before = await admin!.query("SELECT * FROM email_outbox");
      if (baseline === "0006")
        expect(before.rows[0]).not.toHaveProperty("delivery_event_at");
      await migrateDatabase(connectionString!);
      await expect(
        assertDatabaseSchema(connectionString!, admin!),
      ).resolves.toBeUndefined();
      const after = await admin!.query("SELECT * FROM email_outbox");
      expect(after.rows).toEqual(
        baseline === "0006"
          ? before.rows.map((row) => ({
              ...row,
              delivery_event_at: null,
              signup_code_id: null,
              source_kind: "auth_token",
            }))
          : before.rows.map((row) => ({
              ...row,
              signup_code_id: null,
              source_kind: "auth_token",
            })),
      );
      expect(
        (await admin!.query("SELECT * FROM auth_password_login_limits")).rows,
      ).toHaveLength(0);
      expect(
        (await admin!.query("SELECT * FROM email_webhook_events")).rows,
      ).toHaveLength(0);
    },
  );

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

    expect(drizzle.rows).toEqual([
      { count: String(readMigrationFiles(migrationConfig).length) },
    ]);
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
