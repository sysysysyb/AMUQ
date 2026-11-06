CREATE TABLE "email_webhook_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"outbox_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_webhook_events_id_check" CHECK ("email_webhook_events"."event_id" ~ '^[A-Za-z0-9_-]{1,128}$'),
	CONSTRAINT "email_webhook_events_type_check" CHECK ("email_webhook_events"."event_type" IN ('email.delivered', 'email.bounced', 'email.complained', 'email.suppressed'))
);
--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "delivery_event_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_webhook_events" ADD CONSTRAINT "email_webhook_events_outbox_id_email_outbox_id_fk" FOREIGN KEY ("outbox_id") REFERENCES "public"."email_outbox"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_webhook_events_outbox_id_index" ON "email_webhook_events" USING btree ("outbox_id");