ALTER TABLE "sql_change_sets" ADD COLUMN "approval_turn_id" text;--> statement-breakpoint
ALTER TABLE "sql_change_sets" ADD COLUMN "approval_tool_call_id" text;--> statement-breakpoint
ALTER TABLE "sql_change_sets" ADD COLUMN "approval_recorded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sql_change_sets" ADD CONSTRAINT "sql_change_sets_approval_evidence_check" CHECK ((
        "sql_change_sets"."approval_turn_id" IS NULL
        AND "sql_change_sets"."approval_tool_call_id" IS NULL
        AND "sql_change_sets"."approval_recorded_at" IS NULL
      ) OR (
        char_length(btrim("sql_change_sets"."approval_turn_id")) BETWEEN 1 AND 255
        AND char_length(btrim("sql_change_sets"."approval_tool_call_id")) BETWEEN 1 AND 255
        AND "sql_change_sets"."approval_recorded_at" IS NOT NULL
      ));