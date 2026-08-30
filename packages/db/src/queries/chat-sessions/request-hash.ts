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

export function hashChatSessionDataSourceIds(
  dataSourceIds: readonly DataSourceId[],
): string {
  const canonicalIds = canonicalizeChatSessionDataSourceIds(dataSourceIds);
  return createHash("sha256")
    .update(JSON.stringify({ dataSourceIds: canonicalIds }))
    .digest("hex");
}
