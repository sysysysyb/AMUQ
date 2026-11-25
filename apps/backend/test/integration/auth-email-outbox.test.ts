import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { expect, it, vi } from "vitest";

import { migrateDatabase } from "#backend/db/migrations";
import { deliverPendingEmails } from "#backend/jobs/send-email";
import {
  issueSignupChallenge,
  resendSignupChallenge,
} from "#backend/modules/auth/signup-challenge";
import type { ResendEmail } from "#backend/modules/email/resend";
import {
  authTokenSecret,
  setupAuthDatabase,
} from "#backend-test/support/auth-database";

const { admin, connectionString, databaseTest } = setupAuthDatabase();

databaseTest("authentication email delivery and rate limits", () => {
  it("delivers an active email despite an older consumed-token backlog", async () => {
    await migrateDatabase(connectionString!);
    const now = new Date("2026-09-27T01:00:00.000Z");
    await issueSignupChallenge(
      admin!,
      "active@example.com",
      randomUUID(),
      "203.0.113.30",
      { authTokenSecret, rateLimitSecret: "r".repeat(32) },
      () => now,
    );
    const user = await admin!.query<{ id: string }>(
      "INSERT INTO users (email) VALUES ('backlog@example.com') RETURNING id::text",
    );
    await admin!.query(
      `WITH tokens AS (
         INSERT INTO auth_tokens
           (user_id, purpose, token_hash, created_at, expires_at, consumed_at)
         SELECT $1,
                'email_verification',
                md5(sequence::text) || md5(sequence::text),
                 $2::timestamptz - interval '2 hours' + sequence * interval '1 second',
                 $2::timestamptz + interval '1 hour',
                $2
           FROM generate_series(1, 26) AS sequence
         RETURNING id, created_at
       )
       INSERT INTO email_outbox (token_id, token_key_id, created_at, updated_at)
       SELECT id, 'aaaaaaaaaaaaaaaa', created_at, created_at FROM tokens`,
      [user.rows[0]!.id, now],
    );
    const sendEmail = vi.fn<
      (email: ResendEmail) => Promise<{ providerMessageId: string }>
    >(async () => ({
      providerMessageId: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794",
    }));

    await expect(
      deliverPendingEmails(
        { executeSql: (sql, values) => admin!.query(sql, values) },
        {
          authTokenSecret,
          clock: () => now,
          from: "AMUQ <account@example.com>",
          sendEmail,
          webOrigin: "https://example.com",
        },
      ),
    ).resolves.toEqual({ failed: 25, retrying: 0, sent: 1 });
    expect(sendEmail).toHaveBeenCalledOnce();
    expect(sendEmail.mock.calls[0]![0].to).toBe("active@example.com");
    const backlog = await admin!.query<{
      count: string;
      lastErrorCode: string | null;
      status: string;
    }>(
      `SELECT outbox.status,
              outbox.last_error_code AS "lastErrorCode",
              count(*)::text
         FROM email_outbox AS outbox
         JOIN auth_tokens AS token ON token.id = outbox.token_id
        WHERE token.consumed_at IS NOT NULL
        GROUP BY outbox.status, outbox.last_error_code
        ORDER BY outbox.status::text`,
    );
    expect(backlog.rows).toEqual([
      { count: "25", lastErrorCode: "token_consumed", status: "failed" },
      { count: "1", lastErrorCode: null, status: "pending" },
    ]);
  });

  it("does not overwrite an active delivery when resend supersedes its token", async () => {
    await migrateDatabase(connectionString!);
    const now = new Date("2026-09-27T01:00:00.000Z");
    const options = {
      authTokenSecret,
      rateLimitSecret: "r".repeat(32),
    };
    const challenge = await issueSignupChallenge(
      admin!,
      "resend-during-delivery@example.com",
      randomUUID(),
      "203.0.113.31",
      options,
      () => new Date(now.getTime() - 60_000),
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
    let deliveryCount = 0;
    const sendEmail = vi.fn(async () => {
      deliveryCount += 1;
      if (deliveryCount === 1) await deliveryAccepted;
      return {
        providerMessageId:
          deliveryCount === 1
            ? "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794"
            : "c80f71b7-8c27-4f11-8b33-c5cac2c8a890",
      };
    });
    let currentTime = new Date(now.getTime() + 1_000);
    const delivery = deliverPendingEmails(database, {
      authTokenSecret,
      clock: () => currentTime,
      from: "AMUQ <account@example.com>",
      sendEmail,
      webOrigin: "https://example.com",
    });

    try {
      await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledOnce());
      await resendSignupChallenge(
        admin!,
        challenge.attemptToken,
        randomUUID(),
        "203.0.113.32",
        options,
        () => new Date(now.getTime() + 2_000),
      );
      currentTime = new Date(now.getTime() + 3_000);
      acceptDelivery();

      const deliveryResult = await delivery;
      const stored = await admin!.query<{
        attemptCount: number;
        lastErrorCode: string | null;
        providerMessageId: string | null;
        status: string;
      }>(
        `SELECT attempt_count AS "attemptCount",
                last_error_code AS "lastErrorCode",
                provider_message_id AS "providerMessageId",
                status
           FROM email_outbox
          ORDER BY created_at, id`,
      );
      expect({ deliveryResult, stored: stored.rows }).toEqual({
        deliveryResult: {
          failed: 0,
          retrying: 0,
          sent: 2,
        },
        stored: [
          {
            attemptCount: 1,
            lastErrorCode: null,
            providerMessageId: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794",
            status: "sent",
          },
          {
            attemptCount: 1,
            lastErrorCode: null,
            providerMessageId: "c80f71b7-8c27-4f11-8b33-c5cac2c8a890",
            status: "sent",
          },
        ],
      });
    } finally {
      acceptDelivery();
      await delivery.catch(() => undefined);
      await deliveryPool.end();
    }
  });
});
