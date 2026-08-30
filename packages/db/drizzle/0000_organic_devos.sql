CREATE TYPE "public"."data_source_status" AS ENUM('awaiting_upload', 'testing', 'ready', 'failed', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."data_source_type" AS ENUM('csv', 'xlsx', 'postgresql');--> statement-breakpoint
CREATE TABLE "data_source_credentials" (
	"data_source_id" text PRIMARY KEY NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"auth_tag" text NOT NULL,
	"encryption_version" integer NOT NULL,
	CONSTRAINT "data_source_credentials_ciphertext_nonempty_check" CHECK (char_length("data_source_credentials"."ciphertext") > 0),
	CONSTRAINT "data_source_credentials_iv_nonempty_check" CHECK (char_length("data_source_credentials"."iv") > 0),
	CONSTRAINT "data_source_credentials_auth_tag_nonempty_check" CHECK (char_length("data_source_credentials"."auth_tag") > 0),
	CONSTRAINT "data_source_credentials_encryption_version_check" CHECK ("data_source_credentials"."encryption_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "data_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"connector_type" "data_source_type" NOT NULL,
	"name" text NOT NULL,
	"status" "data_source_status" NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"original_filename" text,
	"mime_type" text,
	"file_size_bytes" bigint,
	"azure_blob_name" text,
	"azure_etag" text,
	"processing_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "data_sources_id_format_check" CHECK ("data_sources"."id" ~ '^ds_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "data_sources_name_nonempty_check" CHECK (char_length(btrim("data_sources"."name")) > 0),
	CONSTRAINT "data_sources_config_object_check" CHECK (jsonb_typeof("data_sources"."config") = 'object'),
	CONSTRAINT "data_sources_file_size_check" CHECK ("data_sources"."file_size_bytes" IS NULL OR "data_sources"."file_size_bytes" >= 0),
	CONSTRAINT "data_sources_connector_metadata_check" CHECK ((
        "data_sources"."connector_type" = 'postgresql'
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
      )),
	CONSTRAINT "data_sources_connector_status_check" CHECK ((
        "data_sources"."connector_type" IN ('csv', 'xlsx')
        AND "data_sources"."status" <> 'testing'
      ) OR (
        "data_sources"."connector_type" = 'postgresql'
        AND "data_sources"."status" <> 'awaiting_upload'
      )),
	CONSTRAINT "data_sources_deleted_state_check" CHECK (("data_sources"."status" = 'deleted') = ("data_sources"."deleted_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "data_source_credentials" ADD CONSTRAINT "data_source_credentials_data_source_id_data_sources_id_fk" FOREIGN KEY ("data_source_id") REFERENCES "public"."data_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_sources_status_type_idx" ON "data_sources" USING btree ("status","connector_type");--> statement-breakpoint
CREATE INDEX "data_sources_deleted_at_idx" ON "data_sources" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "data_sources_ready_created_at_idx" ON "data_sources" USING btree ("created_at") WHERE "data_sources"."status" = 'ready' AND "data_sources"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "data_sources_azure_blob_name_unique_idx" ON "data_sources" USING btree ("azure_blob_name") WHERE "data_sources"."azure_blob_name" IS NOT NULL;