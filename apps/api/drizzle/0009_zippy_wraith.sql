CREATE TABLE "auth_password_login_limits" (
	"subject_kind" text NOT NULL,
	"subject_hash" text NOT NULL,
	"window_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"pending_attempts" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	CONSTRAINT "auth_password_login_limits_subject_kind_subject_hash_pk" PRIMARY KEY("subject_kind","subject_hash"),
	CONSTRAINT "auth_password_login_limits_subject_check" CHECK ("auth_password_login_limits"."subject_kind" IN ('client_address', 'identifier_client_address') AND "auth_password_login_limits"."subject_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "auth_password_login_limits_window_check" CHECK ("auth_password_login_limits"."window_started_at" < "auth_password_login_limits"."expires_at"),
	CONSTRAINT "auth_password_login_limits_budget_check" CHECK (
      "auth_password_login_limits"."attempt_count" >= 0
      AND coalesce(array_ndims("auth_password_login_limits"."pending_attempts"), 1) = 1
      AND coalesce(array_lower("auth_password_login_limits"."pending_attempts", 1), 1) = 1
      AND array_position("auth_password_login_limits"."pending_attempts", NULL) IS NULL
      AND (("auth_password_login_limits"."subject_kind" = 'client_address' AND "auth_password_login_limits"."attempt_count" <= 100 AND cardinality("auth_password_login_limits"."pending_attempts") = 0)
        OR ("auth_password_login_limits"."subject_kind" = 'identifier_client_address' AND "auth_password_login_limits"."attempt_count" + cardinality("auth_password_login_limits"."pending_attempts") <= 10))
    )
);
--> statement-breakpoint
CREATE INDEX "auth_password_login_limits_expires_at_index" ON "auth_password_login_limits" USING btree ("expires_at");