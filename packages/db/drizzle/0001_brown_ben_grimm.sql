ALTER TABLE "data_sources" DROP CONSTRAINT "data_sources_file_size_check";--> statement-breakpoint
ALTER TABLE "data_source_credentials" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "data_source_credentials" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "data_source_credentials" ADD CONSTRAINT "data_source_credentials_revision_check" CHECK ("data_source_credentials"."revision" > 0);--> statement-breakpoint
ALTER TABLE "data_sources" ADD CONSTRAINT "data_sources_ready_file_etag_check" CHECK ("data_sources"."connector_type" NOT IN ('csv', 'xlsx')
        OR "data_sources"."status" <> 'ready'
        OR ("data_sources"."azure_etag" IS NOT NULL AND char_length(btrim("data_sources"."azure_etag")) > 0));--> statement-breakpoint
ALTER TABLE "data_sources" ADD CONSTRAINT "data_sources_file_size_check" CHECK ("data_sources"."file_size_bytes" IS NULL OR ("data_sources"."file_size_bytes" >= 0 AND "data_sources"."file_size_bytes" <= 9007199254740991));