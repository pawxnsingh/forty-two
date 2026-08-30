CREATE TYPE "public"."data_source_blob_cleanup_status" AS ENUM('pending', 'deleted', 'missing', 'superseded');--> statement-breakpoint
ALTER TABLE "data_sources" ADD COLUMN "azure_cleanup_status" "data_source_blob_cleanup_status";--> statement-breakpoint
ALTER TABLE "data_sources" ADD COLUMN "azure_cleanup_etag" text;--> statement-breakpoint
ALTER TABLE "data_sources" ADD COLUMN "azure_cleanup_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "data_sources" ADD COLUMN "azure_cleanup_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "data_sources" ADD COLUMN "azure_cleanup_error_code" text;--> statement-breakpoint
UPDATE "data_sources"
SET "azure_cleanup_status" = 'pending',
    "azure_cleanup_etag" = "azure_etag"
WHERE "connector_type" IN ('csv', 'xlsx')
  AND "status" = 'deleted';--> statement-breakpoint
ALTER TABLE "data_sources" ADD CONSTRAINT "data_sources_azure_cleanup_attempts_check" CHECK ("data_sources"."azure_cleanup_attempts" >= 0);--> statement-breakpoint
ALTER TABLE "data_sources" ADD CONSTRAINT "data_sources_azure_cleanup_state_check" CHECK ((
        "data_sources"."connector_type" IN ('csv', 'xlsx')
        AND "data_sources"."status" = 'deleted'
        AND "data_sources"."azure_cleanup_status" IS NOT NULL
        AND ("data_sources"."azure_cleanup_etag" IS NULL OR char_length(btrim("data_sources"."azure_cleanup_etag")) BETWEEN 1 AND 1024)
        AND ("data_sources"."azure_cleanup_error_code" IS NULL OR char_length(btrim("data_sources"."azure_cleanup_error_code")) BETWEEN 1 AND 255)
        AND (
          ("data_sources"."azure_cleanup_status" = 'pending' AND "data_sources"."azure_cleanup_completed_at" IS NULL)
          OR ("data_sources"."azure_cleanup_status" = 'deleted' AND "data_sources"."azure_cleanup_etag" IS NOT NULL AND "data_sources"."azure_cleanup_attempts" > 0 AND "data_sources"."azure_cleanup_completed_at" IS NOT NULL AND "data_sources"."azure_cleanup_error_code" IS NULL)
          OR ("data_sources"."azure_cleanup_status" = 'missing' AND "data_sources"."azure_cleanup_attempts" > 0 AND "data_sources"."azure_cleanup_completed_at" IS NOT NULL AND "data_sources"."azure_cleanup_error_code" IS NULL)
          OR ("data_sources"."azure_cleanup_status" = 'superseded' AND "data_sources"."azure_cleanup_etag" IS NOT NULL AND "data_sources"."azure_cleanup_attempts" > 0 AND "data_sources"."azure_cleanup_completed_at" IS NOT NULL AND "data_sources"."azure_cleanup_error_code" IS NULL)
        )
      ) OR (
        NOT ("data_sources"."connector_type" IN ('csv', 'xlsx') AND "data_sources"."status" = 'deleted')
        AND "data_sources"."azure_cleanup_status" IS NULL
        AND "data_sources"."azure_cleanup_etag" IS NULL
        AND "data_sources"."azure_cleanup_attempts" = 0
        AND "data_sources"."azure_cleanup_completed_at" IS NULL
        AND "data_sources"."azure_cleanup_error_code" IS NULL
      ));
