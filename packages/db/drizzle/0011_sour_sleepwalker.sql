ALTER TABLE "sql_change_executions" DROP CONSTRAINT "sql_change_executions_completion_check";--> statement-breakpoint
ALTER TABLE "sql_change_executions" ADD COLUMN "outcome" "sql_change_status";--> statement-breakpoint
UPDATE "sql_change_executions" AS execution
SET "outcome" = change_set."status"
FROM "sql_change_sets" AS change_set
WHERE execution."change_set_id" = change_set."id"
  AND execution."executed_at" IS NOT NULL
  AND change_set."status" IN ('applied', 'stale', 'partial', 'failed');--> statement-breakpoint
UPDATE "sql_change_executions"
SET "verification" = ("verification" - 'resumable' - 'requiresFreshApproval')
  || '{"phase":"partial_ddl_committed","ddlCommitted":true,"terminal":true,"freshApprovalRequired":true}'::jsonb
WHERE "outcome" = 'partial'
  AND "provider_execution_id" IS NOT NULL
  AND char_length(btrim("provider_execution_id")) BETWEEN 1 AND 1024
  AND "error_code" = 'SqlChangePartialCommitError'
  AND "verification" @> '{"ddlCommitted":true}'::jsonb;--> statement-breakpoint
ALTER TABLE "sql_change_executions" ADD CONSTRAINT "sql_change_executions_partial_evidence_check" CHECK (CASE WHEN "sql_change_executions"."outcome" = 'partial' THEN
          "sql_change_executions"."provider_execution_id" IS NOT NULL
          AND char_length(btrim("sql_change_executions"."provider_execution_id")) BETWEEN 1 AND 1024
          AND "sql_change_executions"."actual_affected_rows" IS NULL
          AND "sql_change_executions"."error_code" = 'SqlChangePartialCommitError'
          AND jsonb_typeof("sql_change_executions"."verification"->'phase') = 'string'
          AND char_length(btrim("sql_change_executions"."verification"->>'phase')) > 0
          AND "sql_change_executions"."verification" @> '{"phase":"partial_ddl_committed","ddlCommitted":true,"terminal":true,"freshApprovalRequired":true}'::jsonb
          AND NOT ("sql_change_executions"."verification" ? 'resumable')
          AND NOT ("sql_change_executions"."verification" ? 'requiresFreshApproval')
        ELSE "sql_change_executions"."error_code" IS DISTINCT FROM 'SqlChangePartialCommitError' END);--> statement-breakpoint
ALTER TABLE "sql_change_executions" ADD CONSTRAINT "sql_change_executions_completion_check" CHECK (("sql_change_executions"."executed_at" IS NULL AND "sql_change_executions"."outcome" IS NULL AND "sql_change_executions"."actual_affected_rows" IS NULL AND "sql_change_executions"."provider_execution_id" IS NULL)
        OR ("sql_change_executions"."executed_at" IS NOT NULL AND "sql_change_executions"."executed_at" >= "sql_change_executions"."started_at"
          AND "sql_change_executions"."outcome" IN ('applied', 'stale', 'partial', 'failed')));
