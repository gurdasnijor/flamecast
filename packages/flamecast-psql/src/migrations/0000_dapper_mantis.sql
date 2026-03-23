CREATE SCHEMA "flamecast";
--> statement-breakpoint
CREATE TABLE "flamecast"."agent_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"spawn" jsonb NOT NULL,
	"runtime" jsonb NOT NULL,
	"managed" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flamecast"."session_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"type" text NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flamecast"."sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_name" text NOT NULL,
	"spawn" jsonb NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_updated_at" timestamp with time zone NOT NULL,
	"pending_permission" jsonb,
	"status" text DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "flamecast"."session_logs" ADD CONSTRAINT "session_logs_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "flamecast"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_templates_list" ON "flamecast"."agent_templates" USING btree ("managed","sort_order","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_session_logs_session" ON "flamecast"."session_logs" USING btree ("session_id","id");