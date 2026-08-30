import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import type { ChatSessionDataSourceBinding } from "../../chat-session-types.js";
import { getDatabase } from "../../database.js";
import { ChatSessionIdSchema, type DataSourceId } from "../../ids.js";
import {
  chatSessionDataSources,
  chatSessions,
} from "../../schema/chat-sessions.js";
import { dataSources } from "../../schema/data-sources.js";
import { type DataSource } from "../../types.js";
import { parseDataSource } from "../data-sources/shared.js";
import { parseChatSessionDataSourceBinding } from "./shared.js";

export const ListChatSessionDataSourcesInputSchema = z.object({
  chatSessionId: ChatSessionIdSchema,
});

export type ListChatSessionDataSourcesInput = z.input<
  typeof ListChatSessionDataSourcesInputSchema
>;

export async function listChatSessionDataSourceBindings(
  input: ListChatSessionDataSourcesInput,
): Promise<ChatSessionDataSourceBinding[]> {
  const parsed = ListChatSessionDataSourcesInputSchema.parse(input);
  const rows = await getDatabase()
    .select({
      chatSessionId: chatSessionDataSources.chatSessionId,
      dataSourceId: chatSessionDataSources.dataSourceId,
    })
    .from(chatSessionDataSources)
    .innerJoin(
      chatSessions,
      eq(chatSessions.id, chatSessionDataSources.chatSessionId),
    )
    .where(
      and(
        eq(chatSessionDataSources.chatSessionId, parsed.chatSessionId),
        isNull(chatSessions.deletedAt),
      ),
    )
    .orderBy(asc(chatSessionDataSources.dataSourceId));

  return rows.map(parseChatSessionDataSourceBinding);
}

export async function listChatSessionDataSourceIds(
  input: ListChatSessionDataSourcesInput,
): Promise<DataSourceId[]> {
  return (await listChatSessionDataSourceBindings(input)).map(
    (binding) => binding.dataSourceId,
  );
}

export async function listChatSessionDataSources(
  input: ListChatSessionDataSourcesInput,
): Promise<DataSource[]> {
  const parsed = ListChatSessionDataSourcesInputSchema.parse(input);
  const rows = await getDatabase()
    .select({ dataSource: dataSources })
    .from(chatSessionDataSources)
    .innerJoin(
      chatSessions,
      eq(chatSessions.id, chatSessionDataSources.chatSessionId),
    )
    .innerJoin(
      dataSources,
      eq(dataSources.id, chatSessionDataSources.dataSourceId),
    )
    .where(
      and(
        eq(chatSessionDataSources.chatSessionId, parsed.chatSessionId),
        isNull(chatSessions.deletedAt),
      ),
    )
    .orderBy(asc(dataSources.id));

  return rows.map((row) => parseDataSource(row.dataSource));
}
