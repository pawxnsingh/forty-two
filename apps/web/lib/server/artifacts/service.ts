import {
  MAX_ARTIFACT_BYTES,
  parseCanonicalTableV1,
  type CanonicalTableV1,
} from "@forty-two/artifacts";
import {
  AnalysisArtifactIdSchema,
  ChatSessionIdSchema,
  getAnalysisArtifact,
  getChatSessionCapabilityScope,
  initializeDatabase,
  listAnalysisArtifactParents,
  listAnalysisArtifacts,
  migrateDatabase,
  verifyArtifactBrowserCapability,
  type AnalysisArtifact,
} from "@forty-two/db";
import {
  ChartArtifactEnvelopeV1Schema,
  type ChartArtifactEnvelopeV1,
} from "@repo/charting/server";
import { z } from "zod";

import { downloadBlobToBuffer } from "../data-sources/azure-storage";
import { readFileDataSourceServerConfig } from "../data-sources/config";

let databaseReadyPromise: Promise<void> | undefined;

async function ensureDatabase(): Promise<void> {
  if (!databaseReadyPromise) {
    databaseReadyPromise = (async () => {
      initializeDatabase();
      await migrateDatabase();
    })().catch((error: unknown) => {
      databaseReadyPromise = undefined;
      throw error;
    });
  }
  await databaseReadyPromise;
}

export class ArtifactApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ArtifactApiError";
  }
}

function ids(sessionId: string, artifactId?: string) {
  const session = ChatSessionIdSchema.safeParse(sessionId);
  const artifact = artifactId
    ? AnalysisArtifactIdSchema.safeParse(artifactId)
    : undefined;
  if (!session.success || (artifact && !artifact.success)) {
    throw new ArtifactApiError(
      404,
      "ARTIFACT_NOT_FOUND",
      "Artifact not found.",
    );
  }
  return { sessionId: session.data, artifactId: artifact?.data };
}

const artifactNotFound = () =>
  new ArtifactApiError(404, "ARTIFACT_NOT_FOUND", "Artifact not found.");

export async function authorizeArtifactRequest(
  request: Request,
  sessionId: string,
): Promise<void> {
  const parsedSession = ChatSessionIdSchema.safeParse(sessionId);
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([^\s,]+)$/i.exec(authorization);
  if (!parsedSession.success || !match) throw artifactNotFound();
  const claims = verifyArtifactBrowserCapability({
    token: match[1]!,
    signingKey: requiredEnvironment("MCP_CAPABILITY_SIGNING_KEY"),
  });
  if (!claims || claims.sub !== parsedSession.data) throw artifactNotFound();
  await ensureDatabase();
  const scope = await getChatSessionCapabilityScope({
    chatSessionId: claims.sub,
    capabilityId: claims.jti,
  });
  if (!scope) throw artifactNotFound();
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function summary(artifact: AnalysisArtifact) {
  return {
    id: artifact.id,
    kind: artifact.kind,
    schemaVersion: artifact.schemaVersion,
    title: artifact.title,
    description: artifact.description,
    contentSha256: artifact.contentSha256,
    byteSize: artifact.byteSize,
    rowCount: artifact.rowCount,
    columnCount: artifact.columnCount,
    sourceLimited: artifact.sourceLimited,
    sourceMaxRows: artifact.sourceMaxRows,
    createdAt: artifact.createdAt.toISOString(),
  };
}

export async function listPublicArtifacts(
  request: Request,
  sessionId: string,
  searchParams: URLSearchParams,
) {
  await authorizeArtifactRequest(request, sessionId);
  const parsedIds = ids(sessionId);
  const query = z
    .object({
      kind: z.enum(["table", "chart"]).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(25),
      pageToken: z.string().min(1).max(2_000).optional(),
    })
    .strict()
    .safeParse(Object.fromEntries(searchParams));
  if (!query.success) {
    throw new ArtifactApiError(
      400,
      "INVALID_ARTIFACT_QUERY",
      "Artifact list parameters are invalid.",
    );
  }
  await ensureDatabase();
  let page;
  try {
    page = await listAnalysisArtifacts({
      chatSessionId: parsedIds.sessionId,
      ...query.data,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ArtifactApiError(
        400,
        "INVALID_PAGE_TOKEN",
        "Artifact page token is invalid.",
      );
    }
    throw error;
  }
  return {
    artifacts: page.artifacts.map(summary),
    nextPageToken: page.nextPageToken,
  };
}

async function activeArtifact(
  sessionId: string,
  artifactId: string,
): Promise<AnalysisArtifact> {
  const parsed = ids(sessionId, artifactId);
  await ensureDatabase();
  const artifact = await getAnalysisArtifact({
    chatSessionId: parsed.sessionId,
    artifactId: parsed.artifactId!,
  });
  if (!artifact) {
    throw new ArtifactApiError(
      404,
      "ARTIFACT_NOT_FOUND",
      "Artifact not found.",
    );
  }
  return artifact;
}

async function downloadTable(
  artifact: AnalysisArtifact,
): Promise<CanonicalTableV1> {
  if (
    artifact.kind !== "table" ||
    !artifact.azureBlobName ||
    !artifact.azureETag ||
    artifact.rowCount === null ||
    !artifact.columns
  ) {
    throw new ArtifactApiError(
      422,
      "ARTIFACT_NOT_DOWNLOADABLE",
      "This artifact has no table payload.",
    );
  }
  if (artifact.byteSize > MAX_ARTIFACT_BYTES) {
    throw new ArtifactApiError(
      413,
      "ARTIFACT_TOO_LARGE",
      "Artifact exceeds the configured download limit.",
    );
  }
  const config = readFileDataSourceServerConfig();
  const bytes = await downloadBlobToBuffer({
    config,
    blobName: artifact.azureBlobName,
    expectedSizeBytes: artifact.byteSize,
    ifMatch: artifact.azureETag,
  });
  try {
    return parseCanonicalTableV1(bytes, {
      contentSha256: artifact.contentSha256,
      byteSize: artifact.byteSize,
      rowCount: artifact.rowCount,
      columns: artifact.columns,
    });
  } catch {
    throw new ArtifactApiError(
      409,
      "ARTIFACT_PAYLOAD_CONFLICT",
      "Artifact payload no longer matches its committed metadata.",
    );
  }
}

const StoredChartConfigSchema = z
  .object({
    sourceArtifactId: AnalysisArtifactIdSchema,
    sourceContentSha256: z.string().regex(/^[0-9a-f]{64}$/),
    config: z.record(z.string(), z.unknown()),
  })
  .strict();

export function buildChartEnvelope(input: {
  chart: AnalysisArtifact;
  source: AnalysisArtifact;
  table: CanonicalTableV1;
}): ChartArtifactEnvelopeV1 {
  if (input.chart.kind !== "chart" || !input.chart.chartConfig) {
    throw new ArtifactApiError(
      409,
      "INVALID_CHART_ARTIFACT",
      "Chart metadata is invalid.",
    );
  }
  const stored = StoredChartConfigSchema.parse(input.chart.chartConfig);
  if (
    input.source.kind !== "table" ||
    stored.sourceArtifactId !== input.source.id ||
    stored.sourceContentSha256 !== input.source.contentSha256
  ) {
    throw new ArtifactApiError(
      409,
      "CHART_SOURCE_CONFLICT",
      "Chart source no longer matches its committed identity.",
    );
  }
  return ChartArtifactEnvelopeV1Schema.parse({
    schemaVersion: "chart.v1",
    id: input.chart.id,
    sourceArtifactId: input.source.id,
    sourceContentSha256: input.source.contentSha256,
    title: input.chart.title,
    description: input.chart.description,
    config: stored.config,
    columns: input.table.columns,
    rowCount: input.table.rowCount,
    sourceLimited: input.source.sourceLimited,
    data: input.table.rows,
    createdAt: input.chart.createdAt.toISOString(),
  });
}

export async function getPublicArtifact(
  request: Request,
  sessionId: string,
  artifactId: string,
) {
  await authorizeArtifactRequest(request, sessionId);
  const artifact = await activeArtifact(sessionId, artifactId);
  const parentArtifactIds = await listAnalysisArtifactParents({
    chatSessionId: artifact.chatSessionId,
    artifactId: artifact.id,
  });
  if (artifact.kind === "table") {
    return {
      ...summary(artifact),
      columns: artifact.columns,
      preview: artifact.preview,
      parentArtifactIds,
      provenance: artifact.provenance,
    };
  }

  const stored = StoredChartConfigSchema.safeParse(artifact.chartConfig);
  if (!stored.success) {
    throw new ArtifactApiError(
      409,
      "INVALID_CHART_ARTIFACT",
      "Chart metadata is invalid.",
    );
  }
  const source = await activeArtifact(sessionId, stored.data.sourceArtifactId);
  const table = await downloadTable(source);
  return buildChartEnvelope({ chart: artifact, source, table });
}

export async function downloadPublicArtifact(
  request: Request,
  sessionId: string,
  artifactId: string,
): Promise<{ bytes: Buffer; etag: string; sha256: string }> {
  await authorizeArtifactRequest(request, sessionId);
  const artifact = await activeArtifact(sessionId, artifactId);
  const table = await downloadTable(artifact);
  return {
    bytes: table.bytes,
    etag: artifact.azureETag!,
    sha256: artifact.contentSha256,
  };
}

export function artifactApiError(error: unknown): Response {
  if (error instanceof ArtifactApiError) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status, headers: { "Cache-Control": "no-store" } },
    );
  }
  console.error("Artifact API failed", error);
  return Response.json(
    { error: { code: "INTERNAL_ERROR", message: "Artifact request failed." } },
    { status: 500, headers: { "Cache-Control": "no-store" } },
  );
}
