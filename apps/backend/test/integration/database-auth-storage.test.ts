import { expect, it } from "vitest";

import { createDatabasePool } from "#backend/db/database";
import { migrateDatabase } from "#backend/db/migrations";
import {
  consumeAuthToken,
  issueAuthToken,
} from "#backend/modules/auth/service";
import { hashOpaqueToken } from "#backend/modules/auth/token";
import { authTokenSecret } from "#backend-test/support/auth-test-secrets";
import { createTestDatabase } from "#backend-test/support/database-fixture";

const { admin, connectionString, databaseTest } = createTestDatabase("suite");

databaseTest("database deployment", () => {
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
});
