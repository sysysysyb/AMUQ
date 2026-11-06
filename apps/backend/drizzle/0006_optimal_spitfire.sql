CREATE TABLE "auth_link_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"primary_provider" "auth_provider" NOT NULL,
	"required_provider" "auth_provider" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "auth_link_sessions_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "auth_link_sessions_token_hash_check" CHECK ("auth_link_sessions"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "auth_link_sessions_provider_check" CHECK ("auth_link_sessions"."primary_provider" <> "auth_link_sessions"."required_provider"),
	CONSTRAINT "auth_link_sessions_expiry_check" CHECK ("auth_link_sessions"."created_at" < "auth_link_sessions"."expires_at"),
	CONSTRAINT "auth_link_sessions_consumed_at_check" CHECK ("auth_link_sessions"."consumed_at" IS NULL OR "auth_link_sessions"."consumed_at" >= "auth_link_sessions"."created_at")
);
--> statement-breakpoint
ALTER TABLE "auth_identities" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auth_identities" ADD COLUMN "activated_at" timestamp with time zone;--> statement-breakpoint
UPDATE "auth_identities" AS identity
   SET "verified_at" = CASE
         WHEN identity."provider" = 'google' THEN identity."created_at"
         ELSE users."email_verified_at"
       END,
       "activated_at" = identity."created_at"
  FROM "users"
 WHERE users."id" = identity."user_id";--> statement-breakpoint
ALTER TABLE "auth_link_sessions" ADD CONSTRAINT "auth_link_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_link_sessions_user_id_index" ON "auth_link_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_link_sessions_expires_at_index" ON "auth_link_sessions" USING btree ("expires_at");
