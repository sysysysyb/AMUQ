import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { readMigrationFiles } from "drizzle-orm/migrator";
import { Pool } from "pg";
import { getRollbackPlans, PgBoss } from "pg-boss";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { assertDatabaseSchema, createDatabasePool } from "#api/db/database";
import { migrationConfig } from "#api/db/migration-config";
import { migrateDatabase } from "#api/db/migrations";
import { deliverPendingEmails } from "#api/jobs/send-email";
import { consumeAuthToken, issueAuthToken } from "#api/modules/auth/service";
import { hashOpaqueToken } from "#api/modules/auth/token";
import { type ResendEmail, ResendEmailError } from "#api/modules/email/resend";
import { startWorker, workerDatabaseOptions } from "#api/worker";
import { assertTestDatabaseUrl } from "#api-test/support/test-database";

const connectionString = process.env.TEST_DATABASE_URL
  ? assertTestDatabaseUrl(process.env.TEST_DATABASE_URL)
  : undefined;
const databaseTest = connectionString ? describe : describe.skip;
const admin = connectionString
  ? createDatabasePool(connectionString)
  : undefined;
const authTokenSecret = "a".repeat(32);

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

  it("enforces authentication storage invariants", async () => {
    await migrateDatabase(connectionString!);

    await expect(
      admin!.query(
        "INSERT INTO users (email) VALUES ('Not-Normalized@Example.com')",
      ),
    ).rejects.toThrow();
    await expect(
      admin!.query(
        "INSERT INTO auth_rate_limits (scope, subject_kind, subject_hash, window_started_at, expires_at) VALUES ('signup', 'identifier', 'raw-email@example.com', now(), now() + interval '1 minute')",
      ),
    ).rejects.toThrow();

    const user = await admin!.query<{ id: string }>(
      "INSERT INTO users (email) VALUES ('learner@example.com') RETURNING id::text",
    );
    const userId = user.rows[0]!.id;

    await expect(
      admin!.query(
        "INSERT INTO auth_identities (user_id, provider, provider_subject, password_hash) VALUES ($1, 'password', 'Learner@Example.com', '$argon2id$test')",
        [userId],
      ),
    ).rejects.toThrow();
    await expect(
      admin!.query(
        "INSERT INTO auth_identities (user_id, provider) VALUES ($1, 'password')",
        [userId],
      ),
    ).rejects.toThrow();

    await admin!.query(
      "INSERT INTO auth_identities (user_id, provider, password_hash) VALUES ($1, 'password', '$argon2id$test')",
      [userId],
    );
    await expect(
      admin!.query(
        "INSERT INTO auth_sessions (user_id, token_hash, idle_expires_at, absolute_expires_at) VALUES ($1, repeat('A', 64), now() + interval '7 days', now() + interval '30 days')",
        [userId],
      ),
    ).rejects.toThrow();
    await expect(
      admin!.query(
        "INSERT INTO auth_sessions (user_id, token_hash, created_at, last_seen_at, idle_expires_at, absolute_expires_at) VALUES ($1, repeat('c', 64), now(), now() + interval '2 days', now() + interval '1 day', now() + interval '30 days')",
        [userId],
      ),
    ).rejects.toThrow();
    await admin!.query(
      "INSERT INTO auth_sessions (user_id, token_hash, idle_expires_at, absolute_expires_at) VALUES ($1, repeat('a', 64), now() + interval '7 days', now() + interval '30 days')",
      [userId],
    );
    await expect(
      admin!.query(
        "INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1, 'email_verification', repeat('b', 63), now() + interval '24 hours')",
        [userId],
      ),
    ).rejects.toThrow();
    await expect(
      admin!.query(
        "INSERT INTO auth_tokens (user_id, purpose, token_hash, created_at, expires_at) VALUES ($1, 'email_verification', repeat('c', 64), now(), now())",
        [userId],
      ),
    ).rejects.toThrow();
    const token = await admin!.query<{ id: string }>(
      "INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1, 'email_verification', repeat('b', 64), now() + interval '24 hours') RETURNING id::text",
      [userId],
    );
    await expect(
      admin!.query(
        "INSERT INTO auth_rate_limits (scope, subject_kind, subject_hash, window_started_at, expires_at, attempt_count) VALUES ('signup', 'identifier', repeat('d', 64), now(), now() + interval '1 minute', -1)",
      ),
    ).rejects.toThrow();
    await expect(
      admin!.query(
        "INSERT INTO auth_rate_limits (scope, subject_kind, subject_hash, window_started_at, expires_at) VALUES ('signup', 'identifier', repeat('d', 64), now(), now())",
      ),
    ).rejects.toThrow();
    await admin!.query(
      "INSERT INTO auth_rate_limits (scope, subject_kind, subject_hash, window_started_at, expires_at, attempt_count) VALUES ('signup', 'identifier', repeat('e', 64), now(), now() + interval '1 minute', 0)",
    );
    await expect(
      admin!.query("INSERT INTO email_outbox (token_id) VALUES ($1)", [
        token.rows[0]!.id,
      ]),
    ).rejects.toThrow();
    await admin!.query(
      "INSERT INTO email_outbox (token_id, token_key_id) VALUES ($1, repeat('f', 16))",
      [token.rows[0]!.id],
    );

    const columns = await admin!.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'email_outbox' ORDER BY column_name",
    );
    const columnNames = columns.rows.map(({ column_name }) => column_name);
    for (const forbiddenColumn of [
      "body",
      "kind",
      "raw_token",
      "recipient",
      "token",
      "user_id",
    ]) {
      expect(columnNames).not.toContain(forbiddenColumn);
    }

    await admin!.query("DELETE FROM users WHERE id = $1", [userId]);
    const relatedRows = await admin!.query<{
      identities: string;
      outbox: string;
      sessions: string;
      tokens: string;
    }>(
      "SELECT (SELECT count(*)::text FROM auth_identities) AS identities, (SELECT count(*)::text FROM auth_sessions) AS sessions, (SELECT count(*)::text FROM auth_tokens) AS tokens, (SELECT count(*)::text FROM email_outbox) AS outbox",
    );
    expect(relatedRows.rows).toEqual([
      { identities: "0", sessions: "0", tokens: "0", outbox: "0" },
    ]);
  });

  it("consumes one-time authentication tokens atomically", async () => {
    await migrateDatabase(connectionString!);
    const user = await admin!.query<{ id: string }>(
      "INSERT INTO users (email) VALUES ('token-user@example.com') RETURNING id::text",
    );
    const userId = user.rows[0]!.id;
    const now = new Date("2026-09-27T00:00:00.000Z");

    const token = await issueAuthToken(
      admin!,
      userId,
      "email_verification",
      authTokenSecret,
      now,
    );
    const stored = await admin!.query<{
      expiresAt: Date;
      id: string;
      tokenHash: string;
    }>(
      'SELECT id::text, expires_at AS "expiresAt", token_hash AS "tokenHash" FROM auth_tokens WHERE user_id = $1',
      [userId],
    );

    expect(stored.rows).toEqual([
      {
        expiresAt: new Date("2026-09-28T00:00:00.000Z"),
        id: token.id,
        tokenHash: hashOpaqueToken(token.rawToken),
      },
    ]);
    expect(stored.rows[0]!.tokenHash).not.toBe(token.rawToken);
    const outbox = await admin!.query<{
      attemptCount: number;
      status: string;
      tokenId: string;
    }>(
      'SELECT token_id::text AS "tokenId", status, attempt_count AS "attemptCount" FROM email_outbox WHERE token_id = $1',
      [token.id],
    );
    expect(outbox.rows).toEqual([
      { attemptCount: 0, status: "pending", tokenId: token.id },
    ]);
    expect(JSON.stringify(outbox.rows)).not.toContain(token.rawToken);
    await expect(
      consumeAuthToken(
        admin!,
        "password_reset",
        token.rawToken,
        new Date("2026-09-27T00:00:30.000Z"),
      ),
    ).resolves.toBeUndefined();
    const firstConsumer = createDatabasePool(connectionString!);
    const secondConsumer = createDatabasePool(connectionString!);
    try {
      const concurrentConsumption = await Promise.all([
        consumeAuthToken(
          firstConsumer,
          "email_verification",
          token.rawToken,
          new Date("2026-09-27T00:01:00.000Z"),
        ),
        consumeAuthToken(
          secondConsumer,
          "email_verification",
          token.rawToken,
          new Date("2026-09-27T00:01:00.000Z"),
        ),
      ]);
      expect(
        concurrentConsumption.filter((value) => value === userId),
      ).toHaveLength(1);
      expect(
        concurrentConsumption.filter((value) => value === undefined),
      ).toHaveLength(1);
    } finally {
      await Promise.all([firstConsumer.end(), secondConsumer.end()]);
    }
    await expect(
      consumeAuthToken(
        admin!,
        "email_verification",
        token.rawToken,
        new Date("2026-09-27T00:02:00.000Z"),
      ),
    ).resolves.toBeUndefined();

    const expiredToken = await issueAuthToken(
      admin!,
      userId,
      "password_reset",
      authTokenSecret,
      new Date("2026-09-26T23:00:00.000Z"),
    );
    await expect(
      consumeAuthToken(admin!, "password_reset", expiredToken.rawToken, now),
    ).resolves.toBeUndefined();
  });

  it("rolls back the token when the outbox insert fails", async () => {
    await migrateDatabase(connectionString!);
    const user = await admin!.query<{ id: string }>(
      "INSERT INTO users (email) VALUES ('rollback-user@example.com') RETURNING id::text",
    );
    await admin!.query(`
      CREATE OR REPLACE FUNCTION reject_email_outbox_insert()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'forced outbox failure';
      END;
      $$;
      CREATE TRIGGER reject_email_outbox_insert
      BEFORE INSERT ON email_outbox
      FOR EACH ROW EXECUTE FUNCTION reject_email_outbox_insert();
    `);

    try {
      await expect(
        issueAuthToken(
          admin!,
          user.rows[0]!.id,
          "email_verification",
          authTokenSecret,
        ),
      ).rejects.toThrow("forced outbox failure");

      const stored = await admin!.query<{ outbox: string; tokens: string }>(
        "SELECT (SELECT count(*)::text FROM auth_tokens) AS tokens, (SELECT count(*)::text FROM email_outbox) AS outbox",
      );
      expect(stored.rows).toEqual([{ outbox: "0", tokens: "0" }]);
    } finally {
      await admin!.query(
        "DROP TRIGGER IF EXISTS reject_email_outbox_insert ON email_outbox",
      );
      await admin!.query("DROP FUNCTION IF EXISTS reject_email_outbox_insert");
    }
  });

  it("safely retires a pending outbox row created before the key id migration", async () => {
    await migrateDatabase(connectionString!);
    await admin!.query(`
      ALTER TABLE email_outbox
        DROP CONSTRAINT email_outbox_token_key_id_check,
        DROP CONSTRAINT email_outbox_pending_token_key_id_check,
        DROP COLUMN token_key_id,
        DROP COLUMN payload_hash;
    `);
    const user = await admin!.query<{ id: string }>(
      "INSERT INTO users (email) VALUES ('legacy-outbox@example.com') RETURNING id::text",
    );
    const token = await admin!.query<{ id: string }>(
      "INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1, 'email_verification', repeat('a', 64), now() + interval '24 hours') RETURNING id::text",
      [user.rows[0]!.id],
    );
    await admin!.query("INSERT INTO email_outbox (token_id) VALUES ($1)", [
      token.rows[0]!.id,
    ]);
    const migration = await readFile(
      new URL("../../drizzle/0002_empty_master_mold.sql", import.meta.url),
      "utf8",
    );

    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await admin!.query(statement);
    }

    const outbox = await admin!.query<{
      lastErrorCode: string;
      status: string;
      tokenKeyId: string | null;
    }>(
      'SELECT status, last_error_code AS "lastErrorCode", token_key_id AS "tokenKeyId" FROM email_outbox',
    );
    expect(outbox.rows).toEqual([
      {
        lastErrorCode: "auth_token_key_unavailable",
        status: "failed",
        tokenKeyId: null,
      },
    ]);
  });

  it("retries a lost email response with an unchanged idempotent request", async () => {
    await migrateDatabase(connectionString!);
    const user = await admin!.query<{ id: string }>(
      "INSERT INTO users (email) VALUES ('delivery-user@example.com') RETURNING id::text",
    );
    const issuedAt = new Date("2026-09-27T00:00:00.000Z");
    const token = await issueAuthToken(
      admin!,
      user.rows[0]!.id,
      "password_reset",
      authTokenSecret,
      issuedAt,
    );
    const database = {
      executeSql: async (text: string, values?: unknown[]) =>
        admin!.query(text, values),
    };
    const attemptedEmails: unknown[] = [];
    const lostResponse = vi.fn(async (email: unknown) => {
      attemptedEmails.push(email);
      throw new ResendEmailError("resend_network", true);
    });

    await expect(
      deliverPendingEmails(database, {
        authTokenSecret,
        clock: () => new Date("2026-09-27T00:01:00.000Z"),
        from: "AMUQ <account@example.com>",
        sendEmail: lostResponse,
        webOrigin: "https://example.com",
      }),
    ).resolves.toEqual({ failed: 0, retrying: 1, sent: 0 });

    const acceptedRetry = vi.fn(async (email: unknown) => {
      attemptedEmails.push(email);
      return { providerMessageId: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" };
    });
    await expect(
      deliverPendingEmails(database, {
        authTokenPreviousSecret: authTokenSecret,
        authTokenSecret: "b".repeat(32),
        clock: () => new Date("2026-09-27T00:02:00.000Z"),
        from: "AMUQ <account@example.com>",
        sendEmail: acceptedRetry,
        webOrigin: "https://example.com",
      }),
    ).resolves.toEqual({ failed: 0, retrying: 0, sent: 1 });

    expect(attemptedEmails).toHaveLength(2);
    expect(attemptedEmails[1]).toEqual(attemptedEmails[0]);
    const stored = await admin!.query<{
      attemptCount: number;
      lastErrorCode: string | null;
      providerMessageId: string | null;
      status: string;
      tokenHash: string;
    }>(
      `SELECT outbox.attempt_count AS "attemptCount",
              outbox.last_error_code AS "lastErrorCode",
              outbox.provider_message_id AS "providerMessageId",
              outbox.status,
              token.token_hash AS "tokenHash"
         FROM email_outbox AS outbox
         JOIN auth_tokens AS token ON token.id = outbox.token_id
        WHERE token.id = $1`,
      [token.id],
    );
    expect(stored.rows).toEqual([
      {
        attemptCount: 2,
        lastErrorCode: null,
        providerMessageId: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794",
        status: "sent",
        tokenHash: hashOpaqueToken(token.rawToken),
      },
    ]);
    expect(JSON.stringify(stored.rows)).not.toContain(token.rawToken);
  });

  it("keeps the issued token valid when the secret rotates before delivery", async () => {
    await migrateDatabase(connectionString!);
    const user = await admin!.query<{ id: string }>(
      "INSERT INTO users (email) VALUES ('rotated-secret@example.com') RETURNING id::text",
    );
    const token = await issueAuthToken(
      admin!,
      user.rows[0]!.id,
      "email_verification",
      authTokenSecret,
      new Date("2026-09-27T00:00:00.000Z"),
    );
    const sendEmail = vi.fn<
      (email: ResendEmail) => Promise<{ providerMessageId: string }>
    >(async () => ({
      providerMessageId: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794",
    }));

    await expect(
      deliverPendingEmails(
        {
          executeSql: async (text: string, values?: unknown[]) =>
            admin!.query(text, values),
        },
        {
          authTokenPreviousSecret: authTokenSecret,
          authTokenSecret: "b".repeat(32),
          clock: () => new Date("2026-09-27T00:01:00.000Z"),
          from: "AMUQ <account@example.com>",
          sendEmail,
          webOrigin: "https://example.com",
        },
      ),
    ).resolves.toEqual({ failed: 0, retrying: 0, sent: 1 });

    expect(sendEmail).toHaveBeenCalledOnce();
    expect(sendEmail.mock.calls[0]![0].text).toContain(token.rawToken);
  });

  it("stops before Resend when a retry payload changes", async () => {
    await migrateDatabase(connectionString!);
    const user = await admin!.query<{ id: string }>(
      "INSERT INTO users (email) VALUES ('payload-user@example.com') RETURNING id::text",
    );
    await issueAuthToken(
      admin!,
      user.rows[0]!.id,
      "password_reset",
      authTokenSecret,
      new Date("2026-09-27T00:00:00.000Z"),
    );
    const database = {
      executeSql: async (text: string, values?: unknown[]) =>
        admin!.query(text, values),
    };
    await deliverPendingEmails(database, {
      authTokenSecret,
      clock: () => new Date("2026-09-27T00:01:00.000Z"),
      from: "AMUQ <account@example.com>",
      sendEmail: async () => {
        throw new ResendEmailError("resend_network", true);
      },
      webOrigin: "https://example.com",
    });
    await admin!.query("UPDATE users SET email = $2 WHERE id = $1", [
      user.rows[0]!.id,
      "changed-payload-user@example.com",
    ]);
    const sendEmail = vi.fn();

    await expect(
      deliverPendingEmails(database, {
        authTokenSecret,
        clock: () => new Date("2026-09-27T00:02:00.000Z"),
        from: "AMUQ <account@example.com>",
        sendEmail,
        webOrigin: "https://example.com",
      }),
    ).resolves.toEqual({ failed: 1, retrying: 0, sent: 0 });

    expect(sendEmail).not.toHaveBeenCalled();
    const stored = await admin!.query<{
      attemptCount: number;
      lastErrorCode: string;
      status: string;
    }>(
      'SELECT attempt_count AS "attemptCount", last_error_code AS "lastErrorCode", status FROM email_outbox',
    );
    expect(stored.rows).toEqual([
      {
        attemptCount: 1,
        lastErrorCode: "email_payload_changed",
        status: "failed",
      },
    ]);
  });

  it("claims a pending outbox row once across concurrent workers", async () => {
    await migrateDatabase(connectionString!);
    const user = await admin!.query<{ id: string }>(
      "INSERT INTO users (email) VALUES ('concurrent-delivery@example.com') RETURNING id::text",
    );
    await issueAuthToken(
      admin!,
      user.rows[0]!.id,
      "email_verification",
      authTokenSecret,
      new Date("2026-09-27T00:00:00.000Z"),
    );
    const deliveryPool = new Pool({ connectionString, max: 2 });
    const database = {
      executeSql: async (text: string, values?: unknown[]) =>
        deliveryPool.query(text, values),
    };
    let acceptDelivery!: () => void;
    const deliveryAccepted = new Promise<void>((resolve) => {
      acceptDelivery = resolve;
    });
    const sendEmail = vi.fn(async () => {
      await deliveryAccepted;
      return {
        providerMessageId: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794",
      };
    });
    const options = {
      authTokenSecret,
      clock: () => new Date("2026-09-27T00:01:00.000Z"),
      from: "AMUQ <account@example.com>",
      sendEmail,
      webOrigin: "https://example.com",
    };

    const firstDelivery = deliverPendingEmails(database, options);
    try {
      await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledOnce());
      const secondDelivery = await deliverPendingEmails(database, options);
      acceptDelivery();
      const firstResult = await firstDelivery;

      expect(sendEmail).toHaveBeenCalledOnce();
      expect(firstResult).toEqual({ failed: 0, retrying: 0, sent: 1 });
      expect(secondDelivery).toEqual({ failed: 0, retrying: 0, sent: 0 });
      const stored = await admin!.query<{
        attemptCount: number;
        status: string;
      }>('SELECT attempt_count AS "attemptCount", status FROM email_outbox');
      expect(stored.rows).toEqual([{ attemptCount: 1, status: "sent" }]);
    } finally {
      acceptDelivery();
      await firstDelivery.catch(() => undefined);
      await deliveryPool.end();
    }
  });

  it("does not retire an active delivery claim when its token is consumed", async () => {
    await migrateDatabase(connectionString!);
    const user = await admin!.query<{ id: string }>(
      "INSERT INTO users (email) VALUES ('consumed-during-delivery@example.com') RETURNING id::text",
    );
    const token = await issueAuthToken(
      admin!,
      user.rows[0]!.id,
      "email_verification",
      authTokenSecret,
      new Date("2026-09-27T00:00:00.000Z"),
    );
    const deliveryPool = new Pool({ connectionString, max: 2 });
    const database = {
      executeSql: async (text: string, values?: unknown[]) =>
        deliveryPool.query(text, values),
    };
    let acceptDelivery!: () => void;
    const deliveryAccepted = new Promise<void>((resolve) => {
      acceptDelivery = resolve;
    });
    const sendEmail = vi.fn(async () => {
      await deliveryAccepted;
      return {
        providerMessageId: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794",
      };
    });
    const claimedAt = new Date("2026-09-27T00:01:00.000Z");
    const firstDelivery = deliverPendingEmails(database, {
      authTokenSecret,
      clock: () => claimedAt,
      from: "AMUQ <account@example.com>",
      sendEmail,
      webOrigin: "https://example.com",
    });

    try {
      await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledOnce());
      await consumeAuthToken(
        admin!,
        "email_verification",
        token.rawToken,
        new Date(claimedAt.getTime() + 1_000),
      );
      const cleanupResult = await deliverPendingEmails(database, {
        authTokenSecret,
        clock: () => new Date(claimedAt.getTime() + 2_000),
        from: "AMUQ <account@example.com>",
        sendEmail: vi.fn(),
        webOrigin: "https://example.com",
      });
      acceptDelivery();
      const deliveryResult = await firstDelivery;

      expect(cleanupResult).toEqual({ failed: 0, retrying: 0, sent: 0 });
      expect(deliveryResult).toEqual({ failed: 0, retrying: 0, sent: 1 });
      const stored = await admin!.query<{
        attemptCount: number;
        status: string;
      }>('SELECT attempt_count AS "attemptCount", status FROM email_outbox');
      expect(stored.rows).toEqual([{ attemptCount: 1, status: "sent" }]);
    } finally {
      acceptDelivery();
      await firstDelivery.catch(() => undefined);
      await deliveryPool.end();
    }
  });

  it("does not steal an active delivery claim when its token expires", async () => {
    await migrateDatabase(connectionString!);
    const user = await admin!.query<{ id: string }>(
      "INSERT INTO users (email) VALUES ('expires-during-delivery@example.com') RETURNING id::text",
    );
    const claimedAt = new Date("2026-09-27T00:01:00.000Z");
    const expiresAt = new Date(claimedAt.getTime() + 20_000);
    const token = await issueAuthToken(
      admin!,
      user.rows[0]!.id,
      "email_verification",
      authTokenSecret,
      new Date("2026-09-27T00:00:00.000Z"),
    );
    await admin!.query("UPDATE auth_tokens SET expires_at = $2 WHERE id = $1", [
      token.id,
      expiresAt,
    ]);
    const deliveryPool = new Pool({ connectionString, max: 2 });
    const database = {
      executeSql: async (text: string, values?: unknown[]) =>
        deliveryPool.query(text, values),
    };
    let acceptDelivery!: () => void;
    const deliveryAccepted = new Promise<void>((resolve) => {
      acceptDelivery = resolve;
    });
    const sendEmail = vi.fn(async () => {
      await deliveryAccepted;
      return {
        providerMessageId: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794",
      };
    });
    const firstDelivery = deliverPendingEmails(database, {
      authTokenSecret,
      clock: () => claimedAt,
      from: "AMUQ <account@example.com>",
      sendEmail,
      webOrigin: "https://example.com",
    });

    try {
      await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledOnce());
      const secondDelivery = await deliverPendingEmails(database, {
        authTokenSecret,
        clock: () => new Date(expiresAt.getTime() + 1_000),
        from: "AMUQ <account@example.com>",
        sendEmail: vi.fn(),
        webOrigin: "https://example.com",
      });
      acceptDelivery();
      const firstResult = await firstDelivery;

      expect(secondDelivery).toEqual({ failed: 0, retrying: 0, sent: 0 });
      expect(firstResult).toEqual({ failed: 0, retrying: 0, sent: 1 });
      const stored = await admin!.query<{
        attemptCount: number;
        status: string;
      }>('SELECT attempt_count AS "attemptCount", status FROM email_outbox');
      expect(stored.rows).toEqual([{ attemptCount: 1, status: "sent" }]);
    } finally {
      acceptDelivery();
      await firstDelivery.catch(() => undefined);
      await deliveryPool.end();
    }
  });

  it("prevents an expired worker claim from overwriting a newer delivery", async () => {
    await migrateDatabase(connectionString!);
    const user = await admin!.query<{ id: string }>(
      "INSERT INTO users (email) VALUES ('stale-claim@example.com') RETURNING id::text",
    );
    await issueAuthToken(
      admin!,
      user.rows[0]!.id,
      "email_verification",
      authTokenSecret,
      new Date("2026-09-27T00:00:00.000Z"),
    );
    const deliveryPool = new Pool({ connectionString, max: 2 });
    let releaseStaleClaim!: () => void;
    let reportStaleClaim!: () => void;
    const staleClaimReleased = new Promise<void>((resolve) => {
      releaseStaleClaim = resolve;
    });
    const staleClaimReported = new Promise<void>((resolve) => {
      reportStaleClaim = resolve;
    });
    const staleDatabase = {
      executeSql: async (text: string, values?: unknown[]) => {
        const result = await deliveryPool.query(text, values);
        if (text.includes("SELECT * FROM claimed") && result.rows[0]) {
          reportStaleClaim();
          await staleClaimReleased;
        }
        return result;
      },
    };
    const activeDatabase = {
      executeSql: async (text: string, values?: unknown[]) =>
        deliveryPool.query(text, values),
    };
    const staleSendEmail = vi.fn();
    const activeSendEmail = vi.fn(async () => ({
      providerMessageId: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794",
    }));
    const sharedOptions = {
      authTokenSecret,
      from: "AMUQ <account@example.com>",
      webOrigin: "https://example.com",
    };
    const staleDelivery = deliverPendingEmails(staleDatabase, {
      ...sharedOptions,
      clock: () => new Date("2026-09-27T00:01:00.000Z"),
      sendEmail: staleSendEmail,
    });

    try {
      await staleClaimReported;
      const activeResult = await deliverPendingEmails(activeDatabase, {
        ...sharedOptions,
        clock: () => new Date("2026-09-27T00:02:01.000Z"),
        sendEmail: activeSendEmail,
      });
      releaseStaleClaim();
      const staleResult = await staleDelivery;

      expect(activeResult).toEqual({ failed: 0, retrying: 0, sent: 1 });
      expect(staleResult).toEqual({ failed: 0, retrying: 0, sent: 0 });
      expect(activeSendEmail).toHaveBeenCalledOnce();
      expect(staleSendEmail).not.toHaveBeenCalled();
      const stored = await admin!.query<{
        attemptCount: number;
        status: string;
      }>('SELECT attempt_count AS "attemptCount", status FROM email_outbox');
      expect(stored.rows).toEqual([{ attemptCount: 2, status: "sent" }]);
    } finally {
      releaseStaleClaim();
      await staleDelivery.catch(() => undefined);
      await deliveryPool.end();
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

  it("delivers a pending email through the real worker", async () => {
    await migrateDatabase(connectionString!);
    const user = await admin!.query<{ id: string }>(
      "INSERT INTO users (email) VALUES ('worker-delivery@example.com') RETURNING id::text",
    );
    await issueAuthToken(
      admin!,
      user.rows[0]!.id,
      "email_verification",
      authTokenSecret,
      new Date(),
    );
    const sendEmail = vi.fn(async () => ({
      providerMessageId: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794",
    }));
    const worker = await startWorker({
      connectionString: connectionString!,
      emailDelivery: {
        config: {
          apiKey: "re_test",
          authTokenSecret,
          from: "AMUQ <account@example.com>",
          webOrigin: "https://example.com",
        },
        sendEmail,
      },
      logInfo: vi.fn(),
    });

    try {
      await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledOnce(), {
        timeout: 10_000,
      });
      await vi.waitFor(
        async () => {
          const outbox = await admin!.query<{ status: string }>(
            "SELECT status FROM email_outbox",
          );
          expect(outbox.rows).toEqual([{ status: "sent" }]);
        },
        { timeout: 10_000 },
      );
    } finally {
      await worker.shutdown();
    }
  }, 30_000);

  it("wakes mail queued after the worker is idle within eight seconds", async () => {
    await migrateDatabase(connectionString!);
    const boss = new PgBoss(workerDatabaseOptions(connectionString!));
    vi.spyOn(boss, "schedule").mockResolvedValue(undefined);
    const sendEmail = vi.fn(async () => ({
      providerMessageId: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794",
    }));
    const worker = await startWorker({
      boss,
      connectionString: connectionString!,
      emailDelivery: {
        config: {
          apiKey: "re_test",
          authTokenSecret,
          from: "AMUQ <account@example.com>",
          webOrigin: "https://example.com",
        },
        sendEmail,
      },
      logInfo: vi.fn(),
    });
    try {
      await vi.waitFor(
        async () => {
          const completed = await admin!.query(
            "SELECT count(*)::int AS count FROM pgboss.job WHERE name='send-email' AND state='completed'",
          );
          expect(completed.rows[0].count).toBeGreaterThan(0);
        },
        { timeout: 10_000 },
      );
      const user = await admin!.query<{ id: string }>(
        "INSERT INTO users(email) VALUES('fresh-worker@example.com') RETURNING id",
      );
      const started = performance.now();
      await issueAuthToken(
        admin!,
        user.rows[0]!.id,
        "password_reset",
        authTokenSecret,
        new Date(),
      );
      await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledOnce(), {
        timeout: 8_000,
        interval: 25,
      });
      expect(performance.now() - started).toBeLessThan(8_000);
    } finally {
      await worker.shutdown();
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

const resetDatabase = async () => {
  await admin?.query(
    "DROP TABLE IF EXISTS email_webhook_events, email_outbox, auth_signup_codes, auth_signup_attempts, auth_password_login_limits, auth_rate_limits, auth_oidc_flows, auth_link_sessions, auth_tokens, auth_sessions, auth_identities, users CASCADE",
  );
  await admin?.query(
    "DROP TYPE IF EXISTS email_delivery_status, auth_oidc_flow_mode, auth_token_purpose, auth_rate_limit_subject_kind, auth_rate_limit_scope, auth_provider CASCADE",
  );
  await admin?.query("DROP SCHEMA IF EXISTS pgboss CASCADE");
  await admin?.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
};

const pgBossVersion = async (): Promise<number> => {
  const result = await admin!.query<{ version: number }>(
    "SELECT version FROM pgboss.version",
  );
  return result.rows[0]!.version;
};
