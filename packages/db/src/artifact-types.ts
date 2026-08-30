import { z } from "zod";

import {
  AnalysisArtifactIdSchema,
  ChatSessionIdSchema,
} from "./ids.js";

export const ARTIFACT_KINDS = ["table", "chart"] as const;
export const ARTIFACT_STATUSES = ["ready", "deleted"] as const;
export const ARTIFACT_SCHEMA_VERSIONS = ["table.v1", "chart.v1"] as const;

export const ArtifactKindSchema = z.enum(ARTIFACT_KINDS);
export const ArtifactStatusSchema = z.enum(ARTIFACT_STATUSES);
export const ArtifactSchemaVersionSchema = z.enum(ARTIFACT_SCHEMA_VERSIONS);
export const ArtifactContentSha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const ArtifactColumnSchema = z
  .object({
    name: z.string().min(1).max(256),
    type: z.enum([
      "string",
      "number",
      "integer",
      "decimal",
      "boolean",
      "datetime",
      "json",
    ]),
    nullable: z.boolean(),
    encoding: z.enum(["json", "string"]).optional(),
  })
  .strict();
export const ArtifactColumnsSchema = z
  .array(ArtifactColumnSchema)
  .min(1)
  .max(100)
  .superRefine((columns, context) => {
    const names = new Set<string>();
    for (const [index, column] of columns.entries()) {
      if (!column.name.trim() || names.has(column.name)) {
        context.addIssue({
          code: "custom",
          path: [index, "name"],
          message: "Artifact column names must be non-blank and unique",
        });
      }
      names.add(column.name);
    }
  });

export const ArtifactPreviewSchema = z.array(
  z.record(z.string(), z.unknown()),
).max(30);
export const ArtifactProvenanceSchema = z
  .object({
    tool: z.string().min(1).max(100),
    operationKey: z.string().min(1).max(512),
    dataSourceIds: z.array(z.string()).max(20).default([]),
    sourceReferences: z.array(z.string().min(1).max(1024)).max(50).default([]),
    sqlSha256: ArtifactContentSha256Schema.optional(),
    startedAt: z.string().datetime().optional(),
    completedAt: z.string().datetime(),
  })
  .strict();

export const AnalysisArtifactSchema = z.object({
  id: AnalysisArtifactIdSchema,
  chatSessionId: ChatSessionIdSchema,
  kind: ArtifactKindSchema,
  schemaVersion: ArtifactSchemaVersionSchema,
  title: z.string().max(500).nullable(),
  description: z.string().max(2_000).nullable(),
  status: ArtifactStatusSchema,
  azureBlobName: z.string().nullable(),
  azureETag: z.string().nullable(),
  contentSha256: ArtifactContentSha256Schema,
  byteSize: z.number().int().nonnegative().safe(),
  rowCount: z.number().int().nonnegative().max(10_000).nullable(),
  columnCount: z.number().int().positive().max(100).nullable(),
  columns: ArtifactColumnsSchema.nullable(),
  preview: ArtifactPreviewSchema.nullable(),
  sourceLimited: z.boolean(),
  sourceMaxRows: z.number().int().positive().max(10_000).nullable(),
  chartConfig: z.record(z.string(), z.unknown()).nullable(),
  provenance: ArtifactProvenanceSchema,
  createdAt: z.date(),
  deletedAt: z.date().nullable(),
  retentionExpiresAt: z.date().nullable(),
  cleanupCompletedAt: z.date().nullable(),
});

export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;
export type ArtifactStatus = z.infer<typeof ArtifactStatusSchema>;
export type ArtifactColumn = z.infer<typeof ArtifactColumnSchema>;
export type ArtifactProvenance = z.infer<typeof ArtifactProvenanceSchema>;
export type AnalysisArtifact = z.infer<typeof AnalysisArtifactSchema>;
