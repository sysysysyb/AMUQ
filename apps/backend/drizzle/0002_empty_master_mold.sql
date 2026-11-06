ALTER TABLE "email_outbox" ADD COLUMN "payload_hash" text;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "token_key_id" text;--> statement-breakpoint
UPDATE "email_outbox"
   SET "status" = 'failed',
       "last_error_code" = 'auth_token_key_unavailable',
       "updated_at" = now()
 WHERE "status" = 'pending'
   AND "token_key_id" IS NULL;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_payload_hash_check" CHECK ("email_outbox"."payload_hash" IS NULL OR "email_outbox"."payload_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_token_key_id_check" CHECK ("email_outbox"."token_key_id" IS NULL OR "email_outbox"."token_key_id" ~ '^[0-9a-f]{16}$');--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_pending_token_key_id_check" CHECK ("email_outbox"."status" <> 'pending' OR "email_outbox"."token_key_id" IS NOT NULL);
