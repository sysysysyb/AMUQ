CREATE TABLE "auth_signup_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_key_id" text NOT NULL,
	"email_subject_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_issued_at" timestamp with time zone NOT NULL,
	"proof_hash" text,
	"proof_key_id" text,
	"proof_issued_at" timestamp with time zone,
	"proof_expires_at" timestamp with time zone,
	"proof_consumed_at" timestamp with time zone,
	CONSTRAINT "auth_signup_attempts_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "auth_signup_attempts_proof_hash_unique" UNIQUE("proof_hash"),
	CONSTRAINT "auth_signup_attempts_issuance_check" CHECK ("auth_signup_attempts"."last_issued_at" >= "auth_signup_attempts"."created_at"),
	CONSTRAINT "auth_signup_attempts_email_check" CHECK ("auth_signup_attempts"."email" = lower(btrim("auth_signup_attempts"."email")) AND length("auth_signup_attempts"."email") > 0),
	CONSTRAINT "auth_signup_attempts_token_check" CHECK ("auth_signup_attempts"."token_hash" ~ '^[0-9a-f]{64}$' AND "auth_signup_attempts"."token_key_id" ~ '^[0-9a-f]{16}$' AND "auth_signup_attempts"."email_subject_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "auth_signup_attempts_proof_check" CHECK (("auth_signup_attempts"."proof_hash" IS NULL AND "auth_signup_attempts"."proof_key_id" IS NULL AND "auth_signup_attempts"."proof_issued_at" IS NULL AND "auth_signup_attempts"."proof_expires_at" IS NULL AND "auth_signup_attempts"."proof_consumed_at" IS NULL)
    OR ("auth_signup_attempts"."proof_hash" IS NOT NULL AND "auth_signup_attempts"."proof_key_id" IS NOT NULL AND "auth_signup_attempts"."proof_issued_at" IS NOT NULL AND "auth_signup_attempts"."proof_expires_at" IS NOT NULL
      AND "auth_signup_attempts"."proof_hash" ~ '^[0-9a-f]{64}$' AND "auth_signup_attempts"."proof_key_id" ~ '^[0-9a-f]{16}$'
      AND "auth_signup_attempts"."proof_issued_at" >= "auth_signup_attempts"."created_at" AND "auth_signup_attempts"."proof_expires_at" = "auth_signup_attempts"."proof_issued_at" + interval '30 minutes'
      AND ("auth_signup_attempts"."proof_consumed_at" IS NULL OR "auth_signup_attempts"."proof_consumed_at" >= "auth_signup_attempts"."proof_issued_at")))
);
--> statement-breakpoint
CREATE TABLE "auth_signup_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"recipient" text NOT NULL,
	"operation_hash" text NOT NULL,
	"operation_kind" text NOT NULL,
	"resend_available_at" timestamp with time zone NOT NULL,
	"code_digest" text NOT NULL,
	"token_key_id" text NOT NULL,
	"wrong_attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	CONSTRAINT "auth_signup_codes_operation_hash_unique" UNIQUE("operation_hash"),
	CONSTRAINT "auth_signup_codes_recipient_check" CHECK ("auth_signup_codes"."recipient" = lower(btrim("auth_signup_codes"."recipient")) AND length("auth_signup_codes"."recipient") > 0),
	CONSTRAINT "auth_signup_codes_material_check" CHECK ("auth_signup_codes"."operation_hash" ~ '^[0-9a-f]{64}$' AND "auth_signup_codes"."code_digest" ~ '^[0-9a-f]{64}$' AND "auth_signup_codes"."token_key_id" ~ '^[0-9a-f]{16}$' AND "auth_signup_codes"."operation_kind" IN ('start', 'resend')),
	CONSTRAINT "auth_signup_codes_attempts_check" CHECK ("auth_signup_codes"."wrong_attempts" BETWEEN 0 AND 5),
	CONSTRAINT "auth_signup_codes_time_check" CHECK ("auth_signup_codes"."expires_at" = "auth_signup_codes"."created_at" + interval '10 minutes' AND "auth_signup_codes"."resend_available_at" >= "auth_signup_codes"."created_at" + interval '1 minute'
    AND ("auth_signup_codes"."revoked_at" IS NULL OR "auth_signup_codes"."revoked_at" >= "auth_signup_codes"."created_at")
    AND ("auth_signup_codes"."verified_at" IS NULL OR ("auth_signup_codes"."verified_at" >= "auth_signup_codes"."created_at" AND "auth_signup_codes"."verified_at" < "auth_signup_codes"."expires_at" AND "auth_signup_codes"."revoked_at" IS NULL)))
);
--> statement-breakpoint
ALTER TABLE "email_outbox" ALTER COLUMN "token_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "source_kind" text DEFAULT 'auth_token' NOT NULL;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "signup_code_id" uuid;--> statement-breakpoint
ALTER TABLE "auth_signup_codes" ADD CONSTRAINT "auth_signup_codes_attempt_id_auth_signup_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."auth_signup_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_signup_attempts_cleanup_index" ON "auth_signup_attempts" USING btree ("last_issued_at","id");--> statement-breakpoint
CREATE INDEX "auth_signup_codes_attempt_index" ON "auth_signup_codes" USING btree ("attempt_id","created_at");--> statement-breakpoint
CREATE INDEX "auth_signup_codes_recipient_created_index" ON "auth_signup_codes" USING btree ("recipient","created_at");--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_signup_code_id_auth_signup_codes_id_fk" FOREIGN KEY ("signup_code_id") REFERENCES "public"."auth_signup_codes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_outbox_retired_signup_index" ON "email_outbox" USING btree ("created_at","id") WHERE "email_outbox"."source_kind" = 'signup_code' AND "email_outbox"."signup_code_id" IS NULL AND "email_outbox"."provider_message_id" IS NULL AND "email_outbox"."status" <> 'pending';--> statement-breakpoint
CREATE INDEX "email_outbox_signup_redaction_index" ON "email_outbox" USING btree ("created_at","id") WHERE "email_outbox"."source_kind" = 'signup_code' AND "email_outbox"."status" <> 'pending' AND ("email_outbox"."payload_hash" IS NOT NULL OR "email_outbox"."token_key_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_signup_code_id_unique" UNIQUE("signup_code_id");--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_source_check" CHECK (("email_outbox"."source_kind" = 'auth_token' AND "email_outbox"."token_id" IS NOT NULL AND "email_outbox"."signup_code_id" IS NULL)
        OR ("email_outbox"."source_kind" = 'signup_code' AND "email_outbox"."token_id" IS NULL AND ("email_outbox"."signup_code_id" IS NOT NULL OR "email_outbox"."status" <> 'pending')));