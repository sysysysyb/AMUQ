import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { authSignupCodes, authTokens } from "#api/modules/auth/schema";

export const emailDeliveryStatus = pgEnum("email_delivery_status", [
  "pending",
  "sent",
  "delivered",
  "bounced",
  "complained",
  "failed",
]);

export const emailOutbox = pgTable(
  "email_outbox",
  {
    id: uuid().primaryKey().defaultRandom(),
    sourceKind: text("source_kind").notNull().default("auth_token"),
    tokenId: uuid("token_id").references(() => authTokens.id, {
      onDelete: "cascade",
    }),
    signupCodeId: uuid("signup_code_id").references(() => authSignupCodes.id, {
      onDelete: "set null",
    }),
    status: emailDeliveryStatus().notNull().default("pending"),
    providerMessageId: text("provider_message_id"),
    payloadHash: text("payload_hash"),
    tokenKeyId: text("token_key_id"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastErrorCode: text("last_error_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    deliveryEventAt: timestamp("delivery_event_at", { withTimezone: true }),
  },
  (table) => [
    unique("email_outbox_token_id_unique").on(table.tokenId),
    unique("email_outbox_signup_code_id_unique").on(table.signupCodeId),
    check(
      "email_outbox_source_check",
      sql`(${table.sourceKind} = 'auth_token' AND ${table.tokenId} IS NOT NULL AND ${table.signupCodeId} IS NULL)
        OR (${table.sourceKind} = 'signup_code' AND ${table.tokenId} IS NULL AND (${table.signupCodeId} IS NOT NULL OR ${table.status} <> 'pending'))`,
    ),
    unique("email_outbox_provider_message_id_unique").on(
      table.providerMessageId,
    ),
    index("email_outbox_status_created_at_index").on(
      table.status,
      table.createdAt,
    ),
    index("email_outbox_retired_signup_index")
      .on(table.createdAt, table.id)
      .where(
        sql`${table.sourceKind} = 'signup_code' AND ${table.signupCodeId} IS NULL AND ${table.providerMessageId} IS NULL AND ${table.status} <> 'pending'`,
      ),
    index("email_outbox_signup_redaction_index")
      .on(table.createdAt, table.id)
      .where(
        sql`${table.sourceKind} = 'signup_code' AND ${table.status} <> 'pending' AND (${table.payloadHash} IS NOT NULL OR ${table.tokenKeyId} IS NOT NULL)`,
      ),
    check("email_outbox_attempt_count_check", sql`${table.attemptCount} >= 0`),
    check(
      "email_outbox_payload_hash_check",
      sql`${table.payloadHash} IS NULL OR ${table.payloadHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "email_outbox_token_key_id_check",
      sql`${table.tokenKeyId} IS NULL OR ${table.tokenKeyId} ~ '^[0-9a-f]{16}$'`,
    ),
    check(
      "email_outbox_pending_token_key_id_check",
      sql`${table.status} <> 'pending' OR ${table.tokenKeyId} IS NOT NULL`,
    ),
    check(
      "email_outbox_sent_at_check",
      sql`${table.sentAt} IS NULL OR ${table.sentAt} >= ${table.createdAt}`,
    ),
  ],
);

export const emailWebhookEvents = pgTable(
  "email_webhook_events",
  {
    eventId: text("event_id").primaryKey(),
    outboxId: uuid("outbox_id")
      .notNull()
      .references(() => emailOutbox.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("email_webhook_events_outbox_id_index").on(table.outboxId),
    check(
      "email_webhook_events_id_check",
      sql`${table.eventId} ~ '^[A-Za-z0-9_-]{1,128}$'`,
    ),
    check(
      "email_webhook_events_type_check",
      sql`${table.eventType} IN ('email.delivered', 'email.bounced', 'email.complained', 'email.suppressed')`,
    ),
  ],
);
