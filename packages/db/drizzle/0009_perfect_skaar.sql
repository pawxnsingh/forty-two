ALTER TABLE "chat_sessions" DROP CONSTRAINT "chat_sessions_active_identifiers_check";--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_active_identifiers_check" CHECK ("chat_sessions"."status" <> 'active' OR (
        "chat_sessions"."trueforge_session_id" IS NOT NULL
        AND char_length(btrim("chat_sessions"."trueforge_session_id")) > 0
      ));