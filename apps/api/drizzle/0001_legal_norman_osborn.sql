CREATE TYPE "public"."auth_provider" AS ENUM('password', 'google');--> statement-breakpoint
CREATE TYPE "public"."auth_rate_limit_scope" AS ENUM('signup', 'verification_resend', 'password_reset');--> statement-breakpoint
CREATE TYPE "public"."auth_rate_limit_subject_kind" AS ENUM('client_address', 'identifier');--> statement-breakpoint
CREATE TYPE "public"."auth_token_purpose" AS ENUM('email_verification', 'password_reset');--> statement-breakpoint
CREATE TYPE "public"."email_delivery_status" AS ENUM('pending', 'sent', 'delivered', 'bounced', 'complained', 'failed');--> statement-breakpoint
CREATE TABLE "auth_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "auth_provider" NOT NULL,
	"provider_subject" text,
	"password_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_identities_provider_subject_unique" UNIQUE("provider","provider_subject"),
	CONSTRAINT "auth_identities_user_provider_unique" UNIQUE("user_id","provider"),
	CONSTRAINT "auth_identities_provider_subject_check" CHECK (("auth_identities"."provider" = 'password' AND "auth_identities"."provider_subject" IS NULL) OR ("auth_identities"."provider" = 'google' AND "auth_identities"."provider_subject" IS NOT NULL AND length("auth_identities"."provider_subject") > 0)),
	CONSTRAINT "auth_identities_password_hash_check" CHECK (("auth_identities"."provider" = 'password' AND "auth_identities"."password_hash" IS NOT NULL) OR ("auth_identities"."provider" = 'google' AND "auth_identities"."password_hash" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "auth_rate_limits" (
	"scope" "auth_rate_limit_scope" NOT NULL,
	"subject_kind" "auth_rate_limit_subject_kind" NOT NULL,
	"subject_hash" text NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "auth_rate_limits_primary_key" PRIMARY KEY("scope","subject_kind","subject_hash"),
	CONSTRAINT "auth_rate_limits_subject_hash_check" CHECK ("auth_rate_limits"."subject_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "auth_rate_limits_window_check" CHECK ("auth_rate_limits"."window_started_at" < "auth_rate_limits"."expires_at"),
	CONSTRAINT "auth_rate_limits_attempt_count_check" CHECK ("auth_rate_limits"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"idle_expires_at" timestamp with time zone NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "auth_sessions_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "auth_sessions_token_hash_check" CHECK ("auth_sessions"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "auth_sessions_expiry_check" CHECK ("auth_sessions"."created_at" <= "auth_sessions"."last_seen_at" AND "auth_sessions"."last_seen_at" < "auth_sessions"."idle_expires_at" AND "auth_sessions"."idle_expires_at" <= "auth_sessions"."absolute_expires_at"),
	CONSTRAINT "auth_sessions_revoked_at_check" CHECK ("auth_sessions"."revoked_at" IS NULL OR "auth_sessions"."revoked_at" >= "auth_sessions"."created_at")
);
--> statement-breakpoint
CREATE TABLE "auth_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" "auth_token_purpose" NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "auth_tokens_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "auth_tokens_token_hash_check" CHECK ("auth_tokens"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "auth_tokens_expiry_check" CHECK ("auth_tokens"."created_at" < "auth_tokens"."expires_at"),
	CONSTRAINT "auth_tokens_consumed_at_check" CHECK ("auth_tokens"."consumed_at" IS NULL OR "auth_tokens"."consumed_at" >= "auth_tokens"."created_at")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"email_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_email_normalized_check" CHECK ("users"."email" = lower(btrim("users"."email")) AND length("users"."email") > 0)
);
--> statement-breakpoint
CREATE TABLE "email_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL,
	"status" "email_delivery_status" DEFAULT 'pending' NOT NULL,
	"provider_message_id" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "email_outbox_token_id_unique" UNIQUE("token_id"),
	CONSTRAINT "email_outbox_provider_message_id_unique" UNIQUE("provider_message_id"),
	CONSTRAINT "email_outbox_attempt_count_check" CHECK ("email_outbox"."attempt_count" >= 0),
	CONSTRAINT "email_outbox_sent_at_check" CHECK ("email_outbox"."sent_at" IS NULL OR "email_outbox"."sent_at" >= "email_outbox"."created_at")
);
--> statement-breakpoint
ALTER TABLE "auth_identities" ADD CONSTRAINT "auth_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_token_id_auth_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."auth_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_rate_limits_expires_at_index" ON "auth_rate_limits" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "auth_sessions_user_id_index" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_idle_expires_at_index" ON "auth_sessions" USING btree ("idle_expires_at");--> statement-breakpoint
CREATE INDEX "auth_tokens_user_purpose_index" ON "auth_tokens" USING btree ("user_id","purpose");--> statement-breakpoint
CREATE INDEX "auth_tokens_expires_at_index" ON "auth_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "email_outbox_status_created_at_index" ON "email_outbox" USING btree ("status","created_at");