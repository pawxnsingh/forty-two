ALTER TABLE "chat_sessions" ADD COLUMN "plan" jsonb;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "plan_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "plan_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "plan_question_key" text;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_plan_revision_check" CHECK ("chat_sessions"."plan_revision" >= 0);--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_plan_shape_check" CHECK ("chat_sessions"."plan" IS NULL OR jsonb_typeof("chat_sessions"."plan") = 'object');--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_plan_timestamp_check" CHECK (("chat_sessions"."plan" IS NULL OR "chat_sessions"."plan_updated_at" IS NOT NULL)
        AND ("chat_sessions"."plan_updated_at" IS NULL OR "chat_sessions"."plan_updated_at" >= "chat_sessions"."created_at"));