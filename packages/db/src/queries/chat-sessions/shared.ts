import {
  ChatSessionDataSourceBindingSchema,
  ChatSessionSchema,
  type ChatSession,
  type ChatSessionDataSourceBinding,
} from "../../chat-session-types.js";
import type {
  ChatSessionDataSourceRow,
  ChatSessionRow,
} from "../../schema/chat-sessions.js";

export function parseChatSession(row: ChatSessionRow): ChatSession {
  return ChatSessionSchema.parse(row);
}

export function parseChatSessionDataSourceBinding(
  row: ChatSessionDataSourceRow,
): ChatSessionDataSourceBinding {
  return ChatSessionDataSourceBindingSchema.parse(row);
}

export function parseReturnedChatSession(
  rows: ChatSessionRow[],
  operation: string,
): ChatSession {
  const row = rows[0];

  if (!row) {
    throw new Error(`${operation} did not return a chat session row.`);
  }

  return parseChatSession(row);
}
