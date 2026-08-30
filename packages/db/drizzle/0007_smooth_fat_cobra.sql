CREATE TYPE "public"."sql_change_operation" AS ENUM('insert', 'update', 'delete', 'add_column', 'rename_column', 'add_and_backfill_column');--> statement-breakpoint
CREATE TYPE "public"."sql_change_status" AS ENUM('prepared', 'pending_approval', 'applied', 'denied', 'expired', 'stale', 'failed');--> statement-breakpoint
CREATE TABLE "sql_change_executions" (
	"id" text PRIMARY KEY NOT NULL,
	"change_set_id" text NOT NULL,
	"trueforge_turn_id" text NOT NULL,
	"trueforge_tool_call_id" text NOT NULL,
	"provider_execution_id" text,
	"actual_affected_rows" integer,
	"verification" jsonb NOT NULL,
	"error_code" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"executed_at" timestamp with time zone,
	CONSTRAINT "sql_change_executions_id_format_check" CHECK ("sql_change_executions"."id" ~ '^changeexec_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "sql_change_executions_ids_check" CHECK (char_length(btrim("sql_change_executions"."trueforge_turn_id")) BETWEEN 1 AND 255
        AND char_length(btrim("sql_change_executions"."trueforge_tool_call_id")) BETWEEN 1 AND 255),
	CONSTRAINT "sql_change_executions_rows_check" CHECK ("sql_change_executions"."actual_affected_rows" IS NULL OR "sql_change_executions"."actual_affected_rows" BETWEEN 0 AND 100),
	CONSTRAINT "sql_change_executions_verification_check" CHECK (jsonb_typeof("sql_change_executions"."verification") = 'object'),
	CONSTRAINT "sql_change_executions_completion_check" CHECK (("sql_change_executions"."executed_at" IS NULL AND "sql_change_executions"."actual_affected_rows" IS NULL AND "sql_change_executions"."provider_execution_id" IS NULL)
        OR ("sql_change_executions"."executed_at" IS NOT NULL AND "sql_change_executions"."executed_at" >= "sql_change_executions"."started_at"))
);
--> statement-breakpoint
CREATE TABLE "sql_change_sets" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_session_id" text NOT NULL,
	"data_source_id" text NOT NULL,
	"connector_type" text NOT NULL,
	"sql_dialect" text NOT NULL,
	"operation" "sql_change_operation" NOT NULL,
	"target_catalog" text,
	"target_schema" text,
	"target_table" text NOT NULL,
	"canonical_sql" text NOT NULL,
	"bound_parameters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"structured_operation" jsonb,
	"statement_hash" text NOT NULL,
	"preview" jsonb NOT NULL,
	"preconditions" jsonb NOT NULL,
	"execution_strategy" jsonb NOT NULL,
	"resource_estimate" jsonb,
	"expected_affected_rows" integer NOT NULL,
	"credential_revision" integer NOT NULL,
	"status" "sql_change_status" DEFAULT 'prepared' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sql_change_sets_id_format_check" CHECK ("sql_change_sets"."id" ~ '^change_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "sql_change_sets_connector_check" CHECK ("sql_change_sets"."connector_type" IN ('postgresql','mysql','sqlserver','snowflake','bigquery','redshift')),
	CONSTRAINT "sql_change_sets_dialect_check" CHECK ("sql_change_sets"."sql_dialect" IN ('postgresql','mysql','transactsql','snowflake','bigquery','redshift')),
	CONSTRAINT "sql_change_sets_text_check" CHECK (char_length(btrim("sql_change_sets"."target_table")) BETWEEN 1 AND 255
        AND char_length("sql_change_sets"."canonical_sql") BETWEEN 1 AND 100000),
	CONSTRAINT "sql_change_sets_hash_check" CHECK ("sql_change_sets"."statement_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "sql_change_sets_json_check" CHECK (jsonb_typeof("sql_change_sets"."bound_parameters") = 'array'
        AND ("sql_change_sets"."structured_operation" IS NULL OR jsonb_typeof("sql_change_sets"."structured_operation") = 'object')
        AND jsonb_typeof("sql_change_sets"."preview") = 'object'
        AND jsonb_typeof("sql_change_sets"."preconditions") = 'object'
        AND jsonb_typeof("sql_change_sets"."execution_strategy") = 'object'
        AND ("sql_change_sets"."resource_estimate" IS NULL OR jsonb_typeof("sql_change_sets"."resource_estimate") = 'object')),
	CONSTRAINT "sql_change_sets_row_bound_check" CHECK ("sql_change_sets"."expected_affected_rows" BETWEEN 0 AND 100),
	CONSTRAINT "sql_change_sets_structured_operation_check" CHECK ((
        "sql_change_sets"."operation" IN ('insert','update','delete')
        AND "sql_change_sets"."structured_operation" IS NULL
      ) OR (
        "sql_change_sets"."operation" IN ('add_column','rename_column','add_and_backfill_column')
        AND "sql_change_sets"."structured_operation" IS NOT NULL
      )),
	CONSTRAINT "sql_change_sets_revision_check" CHECK ("sql_change_sets"."credential_revision" > 0),
	CONSTRAINT "sql_change_sets_expiry_check" CHECK ("sql_change_sets"."expires_at" > "sql_change_sets"."created_at" AND "sql_change_sets"."expires_at" <= "sql_change_sets"."created_at" + interval '10 minutes'),
	CONSTRAINT "sql_change_sets_timestamp_check" CHECK ("sql_change_sets"."updated_at" >= "sql_change_sets"."created_at")
);
--> statement-breakpoint
ALTER TABLE "sql_change_executions" ADD CONSTRAINT "sql_change_executions_change_set_id_sql_change_sets_id_fk" FOREIGN KEY ("change_set_id") REFERENCES "public"."sql_change_sets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sql_change_sets" ADD CONSTRAINT "sql_change_sets_chat_session_id_chat_sessions_id_fk" FOREIGN KEY ("chat_session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sql_change_sets" ADD CONSTRAINT "sql_change_sets_data_source_id_data_sources_id_fk" FOREIGN KEY ("data_source_id") REFERENCES "public"."data_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sql_change_executions_change_set_unique_idx" ON "sql_change_executions" USING btree ("change_set_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sql_change_executions_trueforge_tool_unique_idx" ON "sql_change_executions" USING btree ("trueforge_turn_id","trueforge_tool_call_id");--> statement-breakpoint
CREATE INDEX "sql_change_sets_session_created_idx" ON "sql_change_sets" USING btree ("chat_session_id","created_at");--> statement-breakpoint
CREATE INDEX "sql_change_sets_pending_expiry_idx" ON "sql_change_sets" USING btree ("status","expires_at");