ALTER TYPE "public"."data_source_type" ADD VALUE 'mysql';--> statement-breakpoint
ALTER TYPE "public"."data_source_type" ADD VALUE 'sqlserver';--> statement-breakpoint
ALTER TYPE "public"."data_source_type" ADD VALUE 'snowflake';--> statement-breakpoint
ALTER TYPE "public"."data_source_type" ADD VALUE 'bigquery';--> statement-breakpoint
ALTER TYPE "public"."data_source_type" ADD VALUE 'redshift';--> statement-breakpoint
ALTER TABLE "data_sources" DROP CONSTRAINT "data_sources_connector_metadata_check";--> statement-breakpoint
ALTER TABLE "data_sources" DROP CONSTRAINT "data_sources_connector_status_check";--> statement-breakpoint
ALTER TABLE "data_sources" ADD CONSTRAINT "data_sources_connector_metadata_check" CHECK ((
        "data_sources"."connector_type" IN ('postgresql', 'mysql', 'sqlserver', 'snowflake', 'bigquery', 'redshift')
        AND "data_sources"."original_filename" IS NULL
        AND "data_sources"."mime_type" IS NULL
        AND "data_sources"."file_size_bytes" IS NULL
        AND "data_sources"."azure_blob_name" IS NULL
        AND "data_sources"."azure_etag" IS NULL
      ) OR (
        "data_sources"."connector_type" IN ('csv', 'xlsx')
        AND "data_sources"."original_filename" IS NOT NULL
        AND "data_sources"."mime_type" IS NOT NULL
        AND "data_sources"."file_size_bytes" IS NOT NULL
        AND "data_sources"."azure_blob_name" IS NOT NULL
      ));--> statement-breakpoint
ALTER TABLE "data_sources" ADD CONSTRAINT "data_sources_connector_status_check" CHECK ((
        "data_sources"."connector_type" IN ('csv', 'xlsx')
        AND "data_sources"."status" <> 'testing'
      ) OR (
        "data_sources"."connector_type" IN ('postgresql', 'mysql', 'sqlserver', 'snowflake', 'bigquery', 'redshift')
        AND "data_sources"."status" <> 'awaiting_upload'
      ));