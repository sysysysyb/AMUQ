import { beforeEach, expect, it } from "vitest";

import { createDatabasePool } from "#api/db/database";
import { migrateDatabase } from "#api/db/migrations";
import { buildServer } from "#api/http/server";
import { setupAuthDatabase } from "#api-test/support/auth-database";
import {
  providerMessageId,
  webhookHeaders,
  webhookPayload,
  webhookSecret,
} from "#api-test/support/resend-webhook";

const { admin, connectionString, databaseTest } = setupAuthDatabase();

const sendEvent = async (
  type: string,
  id = "msg_fixture",
  createdAt = new Date(),
  database = admin!,
) => {
  const server = await buildServer({
    environment: "test",
    emailWebhook: { database, secret: webhookSecret },
  });
  const payload = webhookPayload(type, createdAt);
  try {
    return await server.inject({
      method: "POST",
      url: "/webhooks/resend",
      headers: webhookHeaders(payload, id),
      payload,
    });
  } finally {
    await server.close();
  }
};

databaseTest("Resend webhook database", () => {
  beforeEach(async () => {
    await migrateDatabase(connectionString!);
    await admin!.query(
      `WITH owner AS (
         INSERT INTO users (email) VALUES ('webhook-owner@example.com') RETURNING id
       ), token AS (
         INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at)
         SELECT id, 'email_verification', repeat('a', 64), now() + interval '24 hours'
         FROM owner RETURNING id
       )
       INSERT INTO email_outbox (token_id, status, provider_message_id, token_key_id, sent_at)
       SELECT id, 'sent', $1, repeat('b', 16), now() FROM token`,
      [providerMessageId],
    );
  });

  it.each([
    ["email.delivered", "delivered", null],
    ["email.bounced", "bounced", null],
    ["email.complained", "complained", null],
    ["email.suppressed", "failed", "resend_suppressed"],
  ])(
    "stores only delivery metadata for %s",
    async (type, status, errorCode) => {
      expect((await sendEvent(type!)).statusCode).toBe(204);
      const outbox = await admin!.query(
        "SELECT status, last_error_code FROM email_outbox",
      );
      expect(outbox.rows).toEqual([{ status, last_error_code: errorCode }]);
      const events = await admin!.query("SELECT * FROM email_webhook_events");
      expect(events.rows).toHaveLength(1);
      expect(events.rows[0]).toMatchObject({
        event_id: "msg_fixture",
        event_type: type,
      });
      expect(Object.keys(events.rows[0]!).sort()).toEqual([
        "event_id",
        "event_type",
        "occurred_at",
        "outbox_id",
        "received_at",
      ]);
      expect(JSON.stringify(events.rows)).not.toMatch(
        /@|Private fixture body|Fixture subject/,
      );
    },
  );

  it("acknowledges duplicate events without changing persisted state", async () => {
    expect((await sendEvent("email.delivered")).statusCode).toBe(204);
    const first = await admin!.query("SELECT * FROM email_outbox");
    expect((await sendEvent("email.bounced")).statusCode).toBe(204);
    const second = await admin!.query("SELECT * FROM email_outbox");
    expect(second.rows).toEqual(first.rows);
    expect(
      (await admin!.query("SELECT * FROM email_webhook_events")).rows,
    ).toHaveLength(1);
  });

  it("serializes duplicate and competing deliveries across two connections", async () => {
    const other = createDatabasePool(connectionString!);
    try {
      const duplicate = await Promise.all([
        sendEvent("email.delivered", "msg_duplicate", new Date(), admin!),
        sendEvent("email.delivered", "msg_duplicate", new Date(), other),
      ]);
      expect(duplicate.map((response) => response.statusCode)).toEqual([
        204, 204,
      ]);
      const competing = await Promise.all([
        sendEvent("email.bounced", "msg_bounce", new Date(), admin!),
        sendEvent("email.delivered", "msg_delivered", new Date(), other),
      ]);
      expect(competing.map((response) => response.statusCode)).toEqual([
        204, 204,
      ]);
      expect(
        (await admin!.query("SELECT status FROM email_outbox")).rows,
      ).toEqual([{ status: "bounced" }]);
      expect(
        (await admin!.query("SELECT * FROM email_webhook_events")).rows,
      ).toHaveLength(3);
    } finally {
      await other.end();
    }
  });

  it("keeps failure states when a delivery notification arrives late", async () => {
    const now = new Date();
    expect(
      (await sendEvent("email.bounced", "msg_bounce", now)).statusCode,
    ).toBe(204);
    expect(
      (
        await sendEvent(
          "email.delivered",
          "msg_old_delivery",
          new Date(now.getTime() - 1_000),
        )
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await sendEvent(
          "email.delivered",
          "msg_new_delivery",
          new Date(now.getTime() + 1_000),
        )
      ).statusCode,
    ).toBe(204);
    expect(
      (await admin!.query("SELECT status FROM email_outbox")).rows,
    ).toEqual([{ status: "bounced" }]);
    expect(
      (await sendEvent("email.complained", "msg_complaint", now)).statusCode,
    ).toBe(204);
    expect(
      (
        await sendEvent(
          "email.suppressed",
          "msg_suppressed",
          new Date(now.getTime() + 2_000),
        )
      ).statusCode,
    ).toBe(204);
    expect(
      (await admin!.query("SELECT status FROM email_outbox")).rows,
    ).toEqual([{ status: "complained" }]);
  });

  it("applies newer events and rejects older events at the same priority", async () => {
    const now = new Date();
    expect(
      (await sendEvent("email.suppressed", "msg_suppressed", now)).statusCode,
    ).toBe(204);
    expect(
      (
        await sendEvent(
          "email.bounced",
          "msg_old_bounce",
          new Date(now.getTime() - 1_000),
        )
      ).statusCode,
    ).toBe(204);
    expect(
      (await admin!.query("SELECT status, last_error_code FROM email_outbox"))
        .rows,
    ).toEqual([{ status: "failed", last_error_code: "resend_suppressed" }]);
    const newer = new Date(now.getTime() + 1_000);
    expect(
      (await sendEvent("email.bounced", "msg_new_bounce", newer)).statusCode,
    ).toBe(204);
    expect(
      (await sendEvent("email.suppressed", "msg_old_suppressed", now))
        .statusCode,
    ).toBe(204);
    expect(
      (
        await admin!.query(
          "SELECT status, last_error_code, delivery_event_at FROM email_outbox",
        )
      ).rows,
    ).toEqual([
      { status: "bounced", last_error_code: null, delivery_event_at: newer },
    ]);
    expect(
      (
        await admin!.query(
          "SELECT event_id, occurred_at FROM email_webhook_events ORDER BY event_id",
        )
      ).rows,
    ).toEqual([
      { event_id: "msg_new_bounce", occurred_at: newer },
      {
        event_id: "msg_old_bounce",
        occurred_at: new Date(now.getTime() - 1_000),
      },
      { event_id: "msg_old_suppressed", occurred_at: now },
      { event_id: "msg_suppressed", occurred_at: now },
    ]);
  });

  it("rolls back the event ID if updating the outbox fails", async () => {
    await admin!
      .query(`CREATE FUNCTION reject_webhook_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Private database failure'; END $$`);
    await admin!
      .query(`CREATE TRIGGER reject_webhook_update BEFORE UPDATE ON email_outbox
      FOR EACH ROW EXECUTE FUNCTION reject_webhook_update()`);
    try {
      const failed = await sendEvent("email.delivered");
      expect(failed.statusCode).toBe(503);
      expect(failed.body).not.toContain("Private database failure");
      expect(
        (await admin!.query("SELECT * FROM email_webhook_events")).rows,
      ).toHaveLength(0);
      expect(
        (await admin!.query("SELECT status FROM email_outbox")).rows,
      ).toEqual([{ status: "sent" }]);
      await admin!.query("DROP TRIGGER reject_webhook_update ON email_outbox");
      expect((await sendEvent("email.delivered")).statusCode).toBe(204);
      expect(
        (await admin!.query("SELECT * FROM email_webhook_events")).rows,
      ).toHaveLength(1);
    } finally {
      await admin!.query("DROP FUNCTION reject_webhook_update() CASCADE");
    }
  });

  it("retries an early event after the provider response is recorded", async () => {
    await admin!.query(
      "UPDATE email_outbox SET status = 'pending', provider_message_id = NULL, sent_at = NULL",
    );
    expect((await sendEvent("email.delivered")).statusCode).toBe(503);
    expect(
      (await admin!.query("SELECT * FROM email_webhook_events")).rows,
    ).toHaveLength(0);
    await admin!.query(
      "UPDATE email_outbox SET status = 'sent', provider_message_id = $1, sent_at = now()",
      [providerMessageId],
    );
    expect((await sendEvent("email.delivered")).statusCode).toBe(204);
    expect(
      (await admin!.query("SELECT status FROM email_outbox")).rows,
    ).toEqual([{ status: "delivered" }]);
  });

  it("removes receipt metadata with its owning outbox", async () => {
    expect((await sendEvent("email.delivered")).statusCode).toBe(204);
    await admin!.query(
      "DELETE FROM users WHERE email = 'webhook-owner@example.com'",
    );
    expect(
      (await admin!.query("SELECT * FROM email_webhook_events")).rows,
    ).toHaveLength(0);
  });
});
