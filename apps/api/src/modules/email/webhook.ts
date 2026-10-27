import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { Webhook } from "svix";

export interface EmailWebhookOptions {
  database: Pick<Pool, "query">;
  secret: string;
}

const webhookBodyLimit = 64 * 1_024;
const deliveryEvents = {
  "email.delivered": { status: "delivered", priority: 1 },
  "email.bounced": { status: "bounced", priority: 2 },
  "email.complained": { status: "complained", priority: 3 },
  "email.suppressed": { status: "failed", priority: 2 },
} as const;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const registerEmailWebhook = async (
  server: FastifyInstance,
  options: EmailWebhookOptions,
) => {
  const verifier = new Webhook(options.secret);
  server.removeContentTypeParser("application/json");
  server.addContentTypeParser(
    "application/json",
    { parseAs: "string", bodyLimit: webhookBodyLimit },
    (_request, body, done) => done(null, body),
  );
  server.post<{ Body: string }>(
    "/webhooks/resend",
    {
      bodyLimit: webhookBodyLimit,
      schema: {
        operationId: "receiveResendWebhook",
        response: { 204: { type: "null" } },
      },
    },
    async (request, reply) => {
      const id = request.headers["svix-id"];
      const timestamp = request.headers["svix-timestamp"];
      const signature = request.headers["svix-signature"];
      let payload: unknown;
      try {
        if (
          typeof request.body !== "string" ||
          typeof id !== "string" ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(id) ||
          typeof timestamp !== "string" ||
          !/^\d{1,12}$/.test(timestamp) ||
          typeof signature !== "string" ||
          signature.length > 2_048
        )
          throw new Error("Invalid webhook headers");
        verifier.verify(request.body, {
          "svix-id": id,
          "svix-timestamp": timestamp,
          "svix-signature": signature,
        });
        payload = JSON.parse(request.body);
        if (!isObject(payload) || typeof payload.type !== "string") {
          throw new Error("Invalid webhook payload");
        }
      } catch {
        return reply.code(400).send({ error: "invalid_webhook" });
      }

      const eventType = payload.type as keyof typeof deliveryEvents;
      if (!Object.hasOwn(deliveryEvents, eventType))
        return reply.code(204).send();
      const occurredAt =
        typeof payload.created_at === "string"
          ? new Date(payload.created_at)
          : undefined;
      if (
        !occurredAt ||
        !Number.isFinite(occurredAt.getTime()) ||
        !/^\d{4}-\d{2}-\d{2}T/.test(payload.created_at as string) ||
        !isObject(payload.data) ||
        typeof payload.data.email_id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          payload.data.email_id,
        )
      )
        return reply.code(400).send({ error: "invalid_webhook" });

      const event = deliveryEvents[eventType];
      try {
        const result = await options.database.query<{ matched: boolean }>(
          `WITH target AS MATERIALIZED (
             SELECT id, status, last_error_code, delivery_event_at,
                    CASE
                      WHEN status = 'complained' THEN 3
                      WHEN status = 'bounced' OR (status = 'failed' AND last_error_code = 'resend_suppressed') THEN 2
                      WHEN status = 'delivered' THEN 1
                      ELSE 0
                    END AS priority
               FROM email_outbox
              WHERE provider_message_id = $2
              FOR UPDATE
           ), recorded AS (
             INSERT INTO email_webhook_events (event_id, outbox_id, event_type, occurred_at)
             SELECT $1, id, $3, $4 FROM target
             ON CONFLICT (event_id) DO NOTHING
             RETURNING outbox_id
           ), updated AS (
             UPDATE email_outbox AS outbox
                SET status = $5::email_delivery_status,
                    last_error_code = CASE WHEN $3 = 'email.suppressed' THEN 'resend_suppressed' ELSE NULL END,
                    delivery_event_at = $4,
                    updated_at = now()
               FROM target, recorded
              WHERE outbox.id = target.id AND target.id = recorded.outbox_id
                AND (target.priority < $6 OR
                     (target.priority = $6 AND (target.delivery_event_at IS NULL OR target.delivery_event_at <= $4)))
             RETURNING outbox.id
           )
           SELECT EXISTS (SELECT 1 FROM target) AS matched`,
          [
            id,
            payload.data.email_id,
            eventType,
            occurredAt,
            event.status,
            event.priority,
          ],
        );
        if (!result.rows[0]?.matched) {
          return reply.code(503).send({ error: "webhook_not_ready" });
        }
      } catch {
        request.log.error(
          { code: "email_webhook_persistence_failed" },
          "Unable to store email webhook",
        );
        return reply.code(503).send({ error: "webhook_unavailable" });
      }
      return reply.code(204).send();
    },
  );
};
