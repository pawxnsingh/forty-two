import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { getDatabase } from "../../database.js";
import { ChatSessionIdSchema } from "../../ids.js";
import {
  chatSessionDataSources,
  chatSessions,
} from "../../schema/chat-sessions.js";
import { dataSources } from "../../schema/data-sources.js";
import { DataSourceTypeSchema, type DataSourceType } from "../../types.js";

export const GetActiveChatSessionScopeInputSchema = z.object({
  chatSessionId: ChatSessionIdSchema,
});

export type GetActiveChatSessionScopeInput = z.input<
  typeof GetActiveChatSessionScopeInputSchema
>;

export type ActiveSessionDataSource = {
  id: string;
  connectorType: DataSourceType;
  name: string;
  originalFilename: string | null;
  mimeType: string | null;
  fileSizeBytes: number | null;
  azureBlobName: string | null;
  azureETag: string | null;
};

export type ActiveChatSessionScope = {
  chatSessionId: string;
  dataSources: ActiveSessionDataSource[];
};

export async function getActiveChatSessionScope(
  input: GetActiveChatSessionScopeInput,
): Promise<ActiveChatSessionScope | null> {
  const parsed = GetActiveChatSessionScopeInputSchema.parse(input);
  const database = getDatabase();
  const sessions = await database
    .select({ chatSessionId: chatSessions.id })
    .from(chatSessions)
    .where(
      and(
        eq(chatSessions.id, parsed.chatSessionId),
        eq(chatSessions.status, "active"),
        isNull(chatSessions.deletedAt),
      ),
    )
    .limit(1);
  const session = sessions[0];
  if (!session) return null;

  const sourceRows = await database
    .select({
      id: dataSources.id,
      connectorType: dataSources.connectorType,
      name: dataSources.name,
      originalFilename: dataSources.originalFilename,
      mimeType: dataSources.mimeType,
      fileSizeBytes: dataSources.fileSizeBytes,
      azureBlobName: dataSources.azureBlobName,
      azureETag: dataSources.azureETag,
    })
    .from(chatSessionDataSources)
    .innerJoin(
      dataSources,
      eq(dataSources.id, chatSessionDataSources.dataSourceId),
    )
    .where(
      and(
        eq(chatSessionDataSources.chatSessionId, parsed.chatSessionId),
        eq(dataSources.status, "ready"),
        isNull(dataSources.deletedAt),
      ),
    )
    .orderBy(asc(dataSources.id));

  return {
    ...session,
    dataSources: sourceRows.map((row) => ({
      ...row,
      connectorType: DataSourceTypeSchema.parse(row.connectorType),
    })),
  };
}
