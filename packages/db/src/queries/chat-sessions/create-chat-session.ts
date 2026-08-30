import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";

import type { ChatSession } from "../../chat-session-types.js";
import { getDatabase } from "../../database.js";
import { DataSourceIdSchema, generateChatSessionId } from "../../ids.js";
import {
  chatSessionDataSources,
  chatSessions,
} from "../../schema/chat-sessions.js";
import { dataSources } from "../../schema/data-sources.js";
import {
  ChatSessionDataSourceLimitError,
  ChatSessionDataSourceUnavailableError,
  ChatSessionIdempotencyConflictError,
} from "./errors.js";
import {
  canonicalizeChatSessionDataSourceIds,
  hashChatSessionDataSourceIds,
} from "./request-hash.js";
import { parseChatSession, parseReturnedChatSession } from "./shared.js";

export const CreateChatSessionInputSchema = z.object({
  dataSourceIds: z.array(DataSourceIdSchema).max(100),
  maxDataSources: z.number().int().min(1).max(100),
  capabilityId: z.string().trim().min(1).max(255),
  capabilityExpiresAt: z.date(),
  idempotencyKey: z.string().trim().min(1).max(255).optional(),
});

export type CreateChatSessionInput = z.input<
  typeof CreateChatSessionInputSchema
>;

export interface CreateChatSessionResult {
  chatSession: ChatSession;
  created: boolean;
}

function resolveIdempotentSession(
  row: typeof chatSessions.$inferSelect,
  requestHash: string,
  idempotencyKey: string,
): CreateChatSessionResult {
  if (row.idempotencyRequestHash !== requestHash) {
    throw new ChatSessionIdempotencyConflictError(idempotencyKey);
  }

  return { chatSession: parseChatSession(row), created: false };
}

export async function createChatSession(
  input: CreateChatSessionInput,
): Promise<CreateChatSessionResult> {
  const parsed = CreateChatSessionInputSchema.parse(input);
  const canonicalDataSourceIds = canonicalizeChatSessionDataSourceIds(
    parsed.dataSourceIds,
  );

  if (canonicalDataSourceIds.length > parsed.maxDataSources) {
    throw new ChatSessionDataSourceLimitError(
      canonicalDataSourceIds.length,
      parsed.maxDataSources,
    );
  }

  const requestHash = parsed.idempotencyKey
    ? hashChatSessionDataSourceIds(canonicalDataSourceIds)
    : null;

  return getDatabase().transaction(async (transaction) => {
    if (parsed.idempotencyKey) {
      const existingRows = await transaction
        .select()
        .from(chatSessions)
        .where(eq(chatSessions.idempotencyKey, parsed.idempotencyKey))
        .limit(1);
      const existing = existingRows[0];

      if (existing) {
        return resolveIdempotentSession(
          existing,
          requestHash!,
          parsed.idempotencyKey,
        );
      }
    }

    const readySources =
      canonicalDataSourceIds.length === 0
        ? []
        : await transaction
            .select({ id: dataSources.id })
            .from(dataSources)
            .where(
              and(
                inArray(dataSources.id, canonicalDataSourceIds),
                eq(dataSources.status, "ready"),
                isNull(dataSources.deletedAt),
              ),
            )
            .for("share");

    if (readySources.length !== canonicalDataSourceIds.length) {
      throw new ChatSessionDataSourceUnavailableError();
    }

    const values = {
      id: generateChatSessionId(),
      capabilityId: parsed.capabilityId,
      capabilityExpiresAt: parsed.capabilityExpiresAt,
      idempotencyKey: parsed.idempotencyKey ?? null,
      idempotencyRequestHash: requestHash,
    };
    const insertedRows = parsed.idempotencyKey
      ? await transaction
          .insert(chatSessions)
          .values(values)
          .onConflictDoNothing({ target: chatSessions.idempotencyKey })
          .returning()
      : await transaction.insert(chatSessions).values(values).returning();
    const inserted = insertedRows[0];

    if (!inserted) {
      const competingRows = await transaction
        .select()
        .from(chatSessions)
        .where(eq(chatSessions.idempotencyKey, parsed.idempotencyKey!))
        .limit(1);
      const competing = competingRows[0];

      if (!competing) {
        throw new Error("Idempotent chat session creation lost its winner.");
      }

      return resolveIdempotentSession(
        competing,
        requestHash!,
        parsed.idempotencyKey!,
      );
    }

    if (canonicalDataSourceIds.length > 0) {
      await transaction.insert(chatSessionDataSources).values(
        canonicalDataSourceIds.map((dataSourceId) => ({
          chatSessionId: inserted.id,
          dataSourceId,
        })),
      );
    }

    return {
      chatSession: parseReturnedChatSession(
        [inserted],
        "Creating a chat session",
      ),
      created: true,
    };
  });
}
