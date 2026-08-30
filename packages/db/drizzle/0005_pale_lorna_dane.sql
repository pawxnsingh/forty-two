CREATE TYPE "public"."analysis_artifact_kind" AS ENUM('table', 'chart');--> statement-breakpoint
CREATE TYPE "public"."analysis_artifact_status" AS ENUM('ready', 'deleted');--> statement-breakpoint
CREATE TABLE "analysis_artifact_lineage" (
	"chat_session_id" text NOT NULL,
	"artifact_id" text NOT NULL,
	"parent_artifact_id" text NOT NULL,
	CONSTRAINT "analysis_artifact_lineage_pk" PRIMARY KEY("artifact_id","parent_artifact_id"),
	CONSTRAINT "analysis_artifact_lineage_no_self_check" CHECK ("analysis_artifact_lineage"."artifact_id" <> "analysis_artifact_lineage"."parent_artifact_id")
);
--> statement-breakpoint
CREATE TABLE "analysis_artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_session_id" text NOT NULL,
	"kind" "analysis_artifact_kind" NOT NULL,
	"schema_version" text NOT NULL,
	"title" text,
	"description" text,
	"status" "analysis_artifact_status" DEFAULT 'ready' NOT NULL,
	"azure_blob_name" text,
	"azure_etag" text,
	"content_sha256" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"row_count" integer,
	"column_count" integer,
	"columns" jsonb,
	"preview" jsonb,
	"source_limited" boolean DEFAULT false NOT NULL,
	"source_max_rows" integer,
	"chart_config" jsonb,
	"provenance" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"retention_expires_at" timestamp with time zone,
	"cleanup_completed_at" timestamp with time zone,
	CONSTRAINT "analysis_artifacts_id_format_check" CHECK ("analysis_artifacts"."id" ~ '^art_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "analysis_artifacts_hash_check" CHECK ("analysis_artifacts"."content_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "analysis_artifacts_size_check" CHECK ("analysis_artifacts"."byte_size" >= 0 AND "analysis_artifacts"."byte_size" <= 9007199254740991),
	CONSTRAINT "analysis_artifacts_title_description_check" CHECK (("analysis_artifacts"."title" IS NULL OR char_length("analysis_artifacts"."title") BETWEEN 1 AND 500)
        AND ("analysis_artifacts"."description" IS NULL OR char_length("analysis_artifacts"."description") BETWEEN 1 AND 2000)),
	CONSTRAINT "analysis_artifacts_kind_payload_check" CHECK ((
        "analysis_artifacts"."kind" = 'table'
        AND "analysis_artifacts"."schema_version" = 'table.v1'
        AND "analysis_artifacts"."azure_blob_name" IS NOT NULL
        AND "analysis_artifacts"."azure_etag" IS NOT NULL
        AND "analysis_artifacts"."row_count" BETWEEN 0 AND 10000
        AND "analysis_artifacts"."column_count" BETWEEN 1 AND 100
        AND jsonb_typeof("analysis_artifacts"."columns") = 'array'
        AND jsonb_array_length("analysis_artifacts"."columns") = "analysis_artifacts"."column_count"
        AND jsonb_typeof("analysis_artifacts"."preview") = 'array'
        AND jsonb_array_length("analysis_artifacts"."preview") <= 30
        AND "analysis_artifacts"."chart_config" IS NULL
      ) OR (
        "analysis_artifacts"."kind" = 'chart'
        AND "analysis_artifacts"."schema_version" = 'chart.v1'
        AND "analysis_artifacts"."azure_blob_name" IS NULL
        AND "analysis_artifacts"."azure_etag" IS NULL
        AND "analysis_artifacts"."row_count" IS NULL
        AND "analysis_artifacts"."column_count" IS NULL
        AND "analysis_artifacts"."columns" IS NULL
        AND "analysis_artifacts"."preview" IS NULL
        AND "analysis_artifacts"."source_limited" = false
        AND "analysis_artifacts"."source_max_rows" IS NULL
        AND jsonb_typeof("analysis_artifacts"."chart_config") = 'object'
      )),
	CONSTRAINT "analysis_artifacts_limit_check" CHECK (("analysis_artifacts"."source_limited" AND "analysis_artifacts"."source_max_rows" IS NOT NULL AND "analysis_artifacts"."source_max_rows" > 0)
        OR (NOT "analysis_artifacts"."source_limited" AND "analysis_artifacts"."source_max_rows" IS NULL)),
	CONSTRAINT "analysis_artifacts_provenance_check" CHECK (jsonb_typeof("analysis_artifacts"."provenance") = 'object'),
	CONSTRAINT "analysis_artifacts_deleted_state_check" CHECK (("analysis_artifacts"."status" = 'deleted') = ("analysis_artifacts"."deleted_at" IS NOT NULL)
        AND ("analysis_artifacts"."deleted_at" IS NULL) = ("analysis_artifacts"."retention_expires_at" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_artifacts_session_id_unique_idx" ON "analysis_artifacts" USING btree ("chat_session_id","id");--> statement-breakpoint
ALTER TABLE "analysis_artifact_lineage" ADD CONSTRAINT "analysis_artifact_lineage_child_session_fk" FOREIGN KEY ("chat_session_id","artifact_id") REFERENCES "public"."analysis_artifacts"("chat_session_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_artifact_lineage" ADD CONSTRAINT "analysis_artifact_lineage_parent_session_fk" FOREIGN KEY ("chat_session_id","parent_artifact_id") REFERENCES "public"."analysis_artifacts"("chat_session_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_artifacts" ADD CONSTRAINT "analysis_artifacts_chat_session_id_chat_sessions_id_fk" FOREIGN KEY ("chat_session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "analysis_artifact_lineage_parent_idx" ON "analysis_artifact_lineage" USING btree ("chat_session_id","parent_artifact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_artifacts_session_hash_kind_unique_idx" ON "analysis_artifacts" USING btree ("chat_session_id","content_sha256","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_artifacts_session_operation_kind_unique_idx" ON "analysis_artifacts" USING btree ("chat_session_id",("provenance"->>'operationKey'),"kind");--> statement-breakpoint
CREATE INDEX "analysis_artifacts_session_list_idx" ON "analysis_artifacts" USING btree ("chat_session_id","created_at","id");--> statement-breakpoint
CREATE INDEX "analysis_artifacts_retention_idx" ON "analysis_artifacts" USING btree ("status","retention_expires_at");--> statement-breakpoint
CREATE FUNCTION prevent_analysis_artifact_mutation() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'ready' THEN
    IF NEW.status <> 'deleted'
      OR (to_jsonb(NEW) - ARRAY['status', 'deleted_at', 'retention_expires_at'])
         IS DISTINCT FROM
         (to_jsonb(OLD) - ARRAY['status', 'deleted_at', 'retention_expires_at'])
    THEN
      RAISE EXCEPTION 'ready analysis artifacts are immutable';
    END IF;
  ELSIF OLD.status = 'deleted' THEN
    IF (to_jsonb(NEW) - 'cleanup_completed_at')
       IS DISTINCT FROM
       (to_jsonb(OLD) - 'cleanup_completed_at')
      OR OLD.cleanup_completed_at IS NOT NULL
      OR NEW.cleanup_completed_at IS NULL
    THEN
      RAISE EXCEPTION 'deleted analysis artifacts permit only one cleanup completion update';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER analysis_artifacts_immutable_trigger
BEFORE UPDATE ON analysis_artifacts
FOR EACH ROW EXECUTE FUNCTION prevent_analysis_artifact_mutation();
