import { readFile } from "node:fs/promises";

import { expect, it, vi } from "vitest";

import { migrateDatabase } from "#backend/db/migrations";
import { deliverPendingEmails } from "#backend/jobs/send-email";
import { issueAuthToken } from "#backend/modules/auth/service";
import { hashOpaqueToken } from "#backend/modules/auth/token";
import {
  type ResendEmail,
  ResendEmailError,
} from "#backend/modules/email/resend";
import { authTokenSecret } from "#backend-test/support/auth-test-secrets";
import { createTestDatabase } from "#backend-test/support/database-fixture";

const { admin, connectionString, databaseTest } = createTestDatabase("suite");

databaseTest("database deployment", () => {
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
});
