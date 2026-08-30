import { createHash } from "node:crypto";

import { z } from "zod";

import { DataSourceIdSchema, type DataSourceId } from "../../ids.js";

const HashChatSessionDataSourcesInputSchema = z
  .array(DataSourceIdSchema)
  .max(100);

export function canonicalizeChatSessionDataSourceIds(
  dataSourceIds: readonly DataSourceId[],
): DataSourceId[] {
  const parsed = HashChatSessionDataSourcesInputSchema.parse(dataSourceIds);
  return [...new Set(parsed)].sort();
}

export interface HashChatSessionRequestInput {
  dataSourceIds: readonly DataSourceId[];
  maxDataSources: number;
  capabilityId: string;
  capabilityExpiresAt: Date;
}

export function hashChatSessionRequest(
  input: HashChatSessionRequestInput,
): string {
  const canonicalIds = canonicalizeChatSessionDataSourceIds(
    input.dataSourceIds,
  );
  return createHash("sha256")
    .update(
      JSON.stringify({
        dataSourceIds: canonicalIds,
        maxDataSources: input.maxDataSources,
        capabilityId: input.capabilityId,
        capabilityExpiresAt: input.capabilityExpiresAt.toISOString(),
      }),
    )
    .digest("hex");
}
