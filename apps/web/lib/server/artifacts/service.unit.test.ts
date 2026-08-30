import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { serializeCanonicalTableV1 } from "@forty-two/artifacts";
import { AnalysisArtifactSchema } from "@forty-two/db";
import { ChartArtifactEnvelopeV1Schema } from "@repo/charting/server";

import { buildChartEnvelope } from "./service";

const now = new Date("2026-08-28T00:00:00.000Z");
const sourceId = "art_01ARZ3NDEKTSV4RRFFQ69G5FAA";
const chartId = "art_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const sessionId = "sess_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const table = serializeCanonicalTableV1({
  columns: [
    { name: "Sales", type: "number", nullable: false },
    { name: "Profit", type: "number", nullable: false },
  ],
  rows: [
    { Sales: 225, Profit: 75 },
    { Sales: 325, Profit: 122 },
  ],
});
const provenance = {
  tool: "test",
  operationKey: "test-operation",
  dataSourceIds: [],
  sourceReferences: [],
  completedAt: now.toISOString(),
};

function sourceArtifact() {
  return AnalysisArtifactSchema.parse({
    id: sourceId,
    chatSessionId: sessionId,
    kind: "table",
    schemaVersion: "table.v1",
    title: "Coffee rows",
    description: null,
    status: "ready",
    azureBlobName: `artifacts/${sessionId}/${sourceId}/table.v1.jsonl`,
    azureETag: '"etag"',
    contentSha256: table.contentSha256,
    byteSize: table.byteSize,
    rowCount: table.rowCount,
    columnCount: table.columns.length,
    columns: table.columns,
    preview: table.preview,
    sourceLimited: false,
    sourceMaxRows: null,
    chartConfig: null,
    provenance,
    createdAt: now,
    deletedAt: null,
    retentionExpiresAt: null,
    cleanupCompletedAt: null,
  });
}

function chartArtifact(sourceContentSha256 = table.contentSha256) {
  return AnalysisArtifactSchema.parse({
    id: chartId,
    chatSessionId: sessionId,
    kind: "chart",
    schemaVersion: "chart.v1",
    title: "Sales vs profit",
    description: null,
    status: "ready",
    azureBlobName: null,
    azureETag: null,
    contentSha256: "b".repeat(64),
    byteSize: 100,
    rowCount: null,
    columnCount: null,
    columns: null,
    preview: null,
    sourceLimited: false,
    sourceMaxRows: null,
    chartConfig: {
      sourceArtifactId: sourceId,
      sourceContentSha256,
      config: {
        selectedChartType: "scatter",
        scatterAxis: { x: ["Sales"], y: ["Profit"] },
      },
    },
    provenance,
    createdAt: now,
    deletedAt: null,
    retentionExpiresAt: null,
    cleanupCompletedAt: null,
  });
}

describe("artifact API chart envelope", () => {
  it("binds every server-loaded row to the committed source hash", () => {
    const envelope = buildChartEnvelope({
      chart: chartArtifact(),
      source: sourceArtifact(),
      table,
    });
    assert.equal(envelope.sourceContentSha256, table.contentSha256);
    assert.deepEqual(envelope.data, table.rows);
    assert.equal(
      ChartArtifactEnvelopeV1Schema.safeParse(envelope).success,
      true,
    );
  });

  it("fails closed when stored chart provenance names a different hash", () => {
    assert.throws(
      () =>
        buildChartEnvelope({
          chart: chartArtifact("c".repeat(64)),
          source: sourceArtifact(),
          table,
        }),
      /no longer matches/,
    );
  });
});
