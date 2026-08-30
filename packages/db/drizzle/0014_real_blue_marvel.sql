ALTER TABLE "analysis_artifacts" DROP CONSTRAINT "analysis_artifacts_id_format_check";--> statement-breakpoint
ALTER TABLE "chat_sessions" DROP CONSTRAINT "chat_sessions_id_format_check";--> statement-breakpoint
ALTER TABLE "data_sources" DROP CONSTRAINT "data_sources_id_format_check";--> statement-breakpoint
ALTER TABLE "sql_change_executions" DROP CONSTRAINT "sql_change_executions_id_format_check";--> statement-breakpoint
ALTER TABLE "sql_change_sets" DROP CONSTRAINT "sql_change_sets_id_format_check";--> statement-breakpoint
ALTER TABLE "analysis_artifacts" ADD CONSTRAINT "analysis_artifacts_id_format_check" CHECK ("analysis_artifacts"."id" ~ '^art_[0-7][0-9A-HJKMNP-TV-Z]{25}$') NOT VALID;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_id_format_check" CHECK ("chat_sessions"."id" ~ '^sess_[0-7][0-9A-HJKMNP-TV-Z]{25}$');--> statement-breakpoint
ALTER TABLE "data_sources" ADD CONSTRAINT "data_sources_id_format_check" CHECK ("data_sources"."id" ~ '^ds_[0-7][0-9A-HJKMNP-TV-Z]{25}$');--> statement-breakpoint
ALTER TABLE "sql_change_executions" ADD CONSTRAINT "sql_change_executions_id_format_check" CHECK ("sql_change_executions"."id" ~ '^changeexec_[0-7][0-9A-HJKMNP-TV-Z]{25}$');--> statement-breakpoint
ALTER TABLE "sql_change_sets" ADD CONSTRAINT "sql_change_sets_connector_dialect_check" CHECK (("sql_change_sets"."connector_type", "sql_change_sets"."sql_dialect") IN (
        ('postgresql','postgresql'),
        ('mysql','mysql'),
        ('sqlserver','transactsql'),
        ('snowflake','snowflake'),
        ('bigquery','bigquery'),
        ('redshift','redshift')
      ));--> statement-breakpoint
ALTER TABLE "sql_change_sets" ADD CONSTRAINT "sql_change_sets_id_format_check" CHECK ("sql_change_sets"."id" ~ '^change_[0-7][0-9A-HJKMNP-TV-Z]{25}$');
