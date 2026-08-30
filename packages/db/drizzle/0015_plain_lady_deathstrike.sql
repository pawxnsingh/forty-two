CREATE TYPE "public"."chat_turn_request_state" AS ENUM('creating', 'created', 'indeterminate');--> statement-breakpoint
CREATE TABLE "chat_turn_requests" (
	"chat_session_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"state" "chat_turn_request_state" DEFAULT 'creating' NOT NULL,
	"trueforge_turn_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_turn_requests_pk" PRIMARY KEY("chat_session_id","idempotency_key"),
	CONSTRAINT "chat_turn_requests_trueforge_turn_id_unique" UNIQUE("trueforge_turn_id"),
	CONSTRAINT "chat_turn_requests_key_check" CHECK (char_length("chat_turn_requests"."idempotency_key") BETWEEN 1 AND 255 AND btrim("chat_turn_requests"."idempotency_key") = "chat_turn_requests"."idempotency_key"),
	CONSTRAINT "chat_turn_requests_hash_check" CHECK ("chat_turn_requests"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "chat_turn_requests_state_turn_check" CHECK (("chat_turn_requests"."state" = 'created' AND "chat_turn_requests"."trueforge_turn_id" IS NOT NULL AND char_length(btrim("chat_turn_requests"."trueforge_turn_id")) BETWEEN 1 AND 192)
        OR ("chat_turn_requests"."state" IN ('creating', 'indeterminate') AND "chat_turn_requests"."trueforge_turn_id" IS NULL)),
	CONSTRAINT "chat_turn_requests_timestamp_order_check" CHECK ("chat_turn_requests"."updated_at" >= "chat_turn_requests"."created_at")
);
--> statement-breakpoint
ALTER TABLE "chat_turn_requests" ADD CONSTRAINT "chat_turn_requests_chat_session_id_chat_sessions_id_fk" FOREIGN KEY ("chat_session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "chat_turn_requests_session_state_idx" ON "chat_turn_requests" USING btree ("chat_session_id","state");