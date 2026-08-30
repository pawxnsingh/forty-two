import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { getDatabase } from "../../database.js";
import { ChatSessionIdSchema } from "../../ids.js";
import {
  chatSessionDataSources,
  chatSessions,
} from "../../schema/chat-sessions.js";
import { dataSources } from "../../schema/data-sources.js";
import { DataSourceTypeSchema, type DataSourceType } from "../../types.js";

const CapabilityIdSchema = z.string().trim().min(1).max(255);

export const GetChatSessionCapabilityScopeInputSchema = z.object({
  chatSessionId: ChatSessionIdSchema,
  capabilityId: CapabilityIdSchema,
  allowCreating: z.boolean().optional().default(false),
});

export type GetChatSessionCapabilityScopeInput = z.input<
  typeof GetChatSessionCapabilityScopeInputSchema
>;

export type ScopedSessionDataSource = {
  id: string;
  connectorType: DataSourceType;
  name: string;
  originalFilename: string | null;
  mimeType: string | null;
  fileSizeBytes: number | null;
  azureBlobName: string | null;
  azureETag: string | null;
};

export type ChatSessionCapabilityScope = {
  chatSessionId: string;
  capabilityId: string;
  capabilityExpiresAt: Date;
  dataSources: ScopedSessionDataSource[];
};

export async function getChatSessionCapabilityScope(
  input: GetChatSessionCapabilityScopeInput,
): Promise<ChatSessionCapabilityScope | null> {
  const parsed = GetChatSessionCapabilityScopeInputSchema.parse(input);
  const allowedStatuses = parsed.allowCreating
    ? (["creating", "active"] as const)
    : (["active"] as const);
  const database = getDatabase();
  const sessionRows = await database
    .select({
      chatSessionId: chatSessions.id,
      capabilityId: chatSessions.capabilityId,
      capabilityExpiresAt: chatSessions.capabilityExpiresAt,
    })
    .from(chatSessions)
    .where(
      and(
        eq(chatSessions.id, parsed.chatSessionId),
        eq(chatSessions.capabilityId, parsed.capabilityId),
        inArray(chatSessions.status, allowedStatuses),
        gt(chatSessions.capabilityExpiresAt, sql`CURRENT_TIMESTAMP`),
        isNull(chatSessions.capabilityRevokedAt),
        isNull(chatSessions.deletedAt),
      ),
    )
    .limit(1);
  const session = sessionRows[0];
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
