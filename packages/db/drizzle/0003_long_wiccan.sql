CREATE TYPE "public"."chat_session_status" AS ENUM('creating', 'active', 'failed', 'deleted');--> statement-breakpoint
CREATE TABLE "chat_session_data_sources" (
	"chat_session_id" text NOT NULL,
	"data_source_id" text NOT NULL,
	CONSTRAINT "chat_session_data_sources_pk" PRIMARY KEY("chat_session_id","data_source_id")
);
--> statement-breakpoint
CREATE TABLE "chat_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"trueforge_session_id" text,
	"mcp_server_name" text,
	"capability_id" text NOT NULL,
	"capability_expires_at" timestamp with time zone NOT NULL,
	"capability_revoked_at" timestamp with time zone,
	"idempotency_key" text,
	"idempotency_request_hash" text,
	"status" "chat_session_status" DEFAULT 'creating' NOT NULL,
	"failure_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "chat_sessions_trueforge_session_id_unique" UNIQUE("trueforge_session_id"),
	CONSTRAINT "chat_sessions_mcp_server_name_unique" UNIQUE("mcp_server_name"),
	CONSTRAINT "chat_sessions_capability_id_unique" UNIQUE("capability_id"),
	CONSTRAINT "chat_sessions_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "chat_sessions_id_format_check" CHECK ("chat_sessions"."id" ~ '^sess_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "chat_sessions_active_identifiers_check" CHECK ("chat_sessions"."status" <> 'active' OR (
        "chat_sessions"."trueforge_session_id" IS NOT NULL
        AND char_length(btrim("chat_sessions"."trueforge_session_id")) > 0
        AND "chat_sessions"."mcp_server_name" IS NOT NULL
        AND char_length(btrim("chat_sessions"."mcp_server_name")) > 0
      )),
	CONSTRAINT "chat_sessions_failure_message_check" CHECK ((
        "chat_sessions"."status" = 'failed'
        AND "chat_sessions"."failure_message" IS NOT NULL
        AND char_length(btrim("chat_sessions"."failure_message")) BETWEEN 1 AND 4000
      ) OR (
        "chat_sessions"."status" IN ('creating', 'active')
        AND "chat_sessions"."failure_message" IS NULL
      ) OR (
        "chat_sessions"."status" = 'deleted'
        AND (
          "chat_sessions"."failure_message" IS NULL
          OR char_length(btrim("chat_sessions"."failure_message")) BETWEEN 1 AND 4000
        )
      )),
	CONSTRAINT "chat_sessions_capability_expiry_check" CHECK ("chat_sessions"."capability_expires_at" > "chat_sessions"."created_at"),
	CONSTRAINT "chat_sessions_idempotency_pair_check" CHECK (("chat_sessions"."idempotency_key" IS NULL) = ("chat_sessions"."idempotency_request_hash" IS NULL)),
	CONSTRAINT "chat_sessions_idempotency_hash_check" CHECK ("chat_sessions"."idempotency_request_hash" IS NULL OR "chat_sessions"."idempotency_request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "chat_sessions_deleted_state_check" CHECK (("chat_sessions"."status" = 'deleted') = ("chat_sessions"."deleted_at" IS NOT NULL)),
	CONSTRAINT "chat_sessions_timestamp_order_check" CHECK ("chat_sessions"."updated_at" >= "chat_sessions"."created_at"
        AND ("chat_sessions"."deleted_at" IS NULL OR "chat_sessions"."deleted_at" >= "chat_sessions"."created_at")
        AND ("chat_sessions"."capability_revoked_at" IS NULL OR "chat_sessions"."capability_revoked_at" >= "chat_sessions"."created_at"))
);
--> statement-breakpoint
ALTER TABLE "chat_session_data_sources" ADD CONSTRAINT "chat_session_data_sources_chat_session_id_chat_sessions_id_fk" FOREIGN KEY ("chat_session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "chat_session_data_sources" ADD CONSTRAINT "chat_session_data_sources_data_source_id_data_sources_id_fk" FOREIGN KEY ("data_source_id") REFERENCES "public"."data_sources"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "chat_session_data_sources_data_source_id_idx" ON "chat_session_data_sources" USING btree ("data_source_id");--> statement-breakpoint
CREATE INDEX "chat_sessions_status_created_at_idx" ON "chat_sessions" USING btree ("status","created_at");--> statement-breakpoint
CREATE FUNCTION "reject_chat_session_data_source_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION 'chat session datasource bindings are immutable'
		USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "chat_session_data_sources_immutable_trigger"
BEFORE UPDATE OR DELETE ON "chat_session_data_sources"
FOR EACH ROW
EXECUTE FUNCTION "reject_chat_session_data_source_mutation"();
