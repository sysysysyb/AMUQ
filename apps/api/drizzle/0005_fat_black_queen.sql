CREATE TYPE "public"."auth_oidc_flow_mode" AS ENUM('login', 'link');--> statement-breakpoint
CREATE TABLE "auth_oidc_flows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"flow_hash" text NOT NULL,
	"state_hash" text NOT NULL,
	"nonce_hash" text NOT NULL,
	"mode" "auth_oidc_flow_mode" NOT NULL,
	"user_id" uuid,
	"session_token_hash" text,
	"return_to" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "auth_oidc_flows_flow_hash_unique" UNIQUE("flow_hash"),
	CONSTRAINT "auth_oidc_flows_state_hash_unique" UNIQUE("state_hash"),
	CONSTRAINT "auth_oidc_flows_hashes_check" CHECK ("auth_oidc_flows"."flow_hash" ~ '^[0-9a-f]{64}$' AND "auth_oidc_flows"."state_hash" ~ '^[0-9a-f]{64}$' AND "auth_oidc_flows"."nonce_hash" ~ '^[0-9a-f]{64}$' AND ("auth_oidc_flows"."session_token_hash" IS NULL OR "auth_oidc_flows"."session_token_hash" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "auth_oidc_flows_mode_owner_check" CHECK (("auth_oidc_flows"."mode" = 'login' AND "auth_oidc_flows"."user_id" IS NULL AND "auth_oidc_flows"."session_token_hash" IS NULL) OR ("auth_oidc_flows"."mode" = 'link' AND "auth_oidc_flows"."user_id" IS NOT NULL AND "auth_oidc_flows"."session_token_hash" IS NOT NULL)),
	CONSTRAINT "auth_oidc_flows_expiry_check" CHECK ("auth_oidc_flows"."created_at" < "auth_oidc_flows"."expires_at"),
	CONSTRAINT "auth_oidc_flows_consumed_at_check" CHECK ("auth_oidc_flows"."consumed_at" IS NULL OR "auth_oidc_flows"."consumed_at" >= "auth_oidc_flows"."created_at")
);
--> statement-breakpoint
ALTER TABLE "auth_oidc_flows" ADD CONSTRAINT "auth_oidc_flows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_oidc_flows_expires_at_index" ON "auth_oidc_flows" USING btree ("expires_at");