ALTER TABLE "sql_change_executions" DROP CONSTRAINT "sql_change_executions_completion_check";--> statement-breakpoint
DO $audit_backfill$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "sql_change_executions" AS execution
    INNER JOIN "sql_change_sets" AS change_set
      ON change_set."id" = execution."change_set_id"
    WHERE execution."executed_at" IS NOT NULL
      AND (
        execution."outcome" IS DISTINCT FROM change_set."status"
        OR (
          (
            change_set."status" = 'applied'
            AND execution."provider_execution_id" IS NOT NULL
            AND char_length(btrim(execution."provider_execution_id")) BETWEEN 1 AND 1024
            AND execution."actual_affected_rows" = change_set."expected_affected_rows"
            AND execution."error_code" IS NULL
            AND execution."verification"->>'phase' = 'verified'
          ) OR (
            change_set."status" = 'partial'
            AND execution."provider_execution_id" IS NOT NULL
            AND char_length(btrim(execution."provider_execution_id")) BETWEEN 1 AND 1024
            AND execution."actual_affected_rows" IS NULL
            AND execution."error_code" = 'SqlChangePartialCommitError'
            AND execution."verification" @> '{"phase":"partial_ddl_committed","ddlCommitted":true,"terminal":true,"freshApprovalRequired":true}'::jsonb
            AND NOT (execution."verification" ? 'resumable')
            AND NOT (execution."verification" ? 'requiresFreshApproval')
          ) OR (
            change_set."status" IN ('stale', 'failed')
            AND execution."provider_execution_id" IS NULL
            AND execution."actual_affected_rows" IS NULL
            AND execution."error_code" IS NOT NULL
            AND char_length(btrim(execution."error_code")) BETWEEN 1 AND 255
            AND execution."verification"->>'phase' = 'failed'
          )
        ) IS NOT TRUE
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Cannot infer SQL execution outcome from authoritative status and provider evidence.';
  END IF;

  UPDATE "sql_change_executions" AS execution
  SET "outcome" = change_set."status"
  FROM "sql_change_sets" AS change_set
  WHERE change_set."id" = execution."change_set_id"
    AND execution."executed_at" IS NOT NULL
    AND execution."outcome" IS NULL
    AND (
      (
        change_set."status" = 'applied'
        AND execution."provider_execution_id" IS NOT NULL
        AND char_length(btrim(execution."provider_execution_id")) BETWEEN 1 AND 1024
        AND execution."actual_affected_rows" = change_set."expected_affected_rows"
        AND execution."error_code" IS NULL
        AND execution."verification"->>'phase' = 'verified'
      ) OR (
        change_set."status" = 'partial'
        AND execution."provider_execution_id" IS NOT NULL
        AND char_length(btrim(execution."provider_execution_id")) BETWEEN 1 AND 1024
        AND execution."actual_affected_rows" IS NULL
        AND execution."error_code" = 'SqlChangePartialCommitError'
        AND execution."verification" @> '{"phase":"partial_ddl_committed","ddlCommitted":true,"terminal":true,"freshApprovalRequired":true}'::jsonb
        AND NOT (execution."verification" ? 'resumable')
        AND NOT (execution."verification" ? 'requiresFreshApproval')
      ) OR (
        change_set."status" IN ('stale', 'failed')
        AND execution."provider_execution_id" IS NULL
        AND execution."actual_affected_rows" IS NULL
        AND execution."error_code" IS NOT NULL
        AND char_length(btrim(execution."error_code")) BETWEEN 1 AND 255
        AND execution."verification"->>'phase' = 'failed'
      )
    ) IS TRUE;
END
$audit_backfill$;--> statement-breakpoint
ALTER TABLE "sql_change_executions" ADD CONSTRAINT "sql_change_executions_completion_check" CHECK (("sql_change_executions"."executed_at" IS NULL AND "sql_change_executions"."outcome" IS NULL AND "sql_change_executions"."actual_affected_rows" IS NULL AND "sql_change_executions"."provider_execution_id" IS NULL)
        OR ("sql_change_executions"."executed_at" IS NOT NULL AND "sql_change_executions"."executed_at" >= "sql_change_executions"."started_at"
          AND "sql_change_executions"."outcome" IS NOT NULL
          AND ("sql_change_executions"."outcome" IN ('applied', 'stale', 'partial', 'failed')) IS TRUE));
