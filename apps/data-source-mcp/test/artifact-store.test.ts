import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { describe, it } from "node:test";

import { serializeCanonicalTableV1 } from "@forty-two/artifacts";
import { validateChartConfigV1 } from "@repo/charting/server";
import type { BlobServiceClient } from "@azure/storage-blob";
import {
  ArtifactStore,
  BeginTableArtifactUploadInputSchema,
  artifactLimits,
} from "../src/artifact-store.js";

const store = new ArtifactStore({
  accountName: "dummy42account",
  accountKey: Buffer.alloc(32, 42).toString("base64"),
  container: "dummy42",
});

const columns = [
  { name: "Sales", type: "number" as const, nullable: false },
  { name: "Profit", type: "number" as const, nullable: false },
];

const chartReceiptFixture = JSON.parse(
  readFileSync(
    new URL(
      "../../../packages/artifacts/test/fixtures/chart-receipt-v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  chatSessionId: string;
  source: {
    id: string;
    contentSha256: string;
    rowCount: number;
    columns: typeof columns;
  };
  request: {
    schemaVersion: "chart.receipt.v1";
    inputArtifactId: string;
    sourceContentSha256: string;
    rowCount: number;
    title: string;
    description: string | null;
    config: Record<string, unknown>;
    warnings: string[];
    receiptSha256: string;
  };
};

describe("Azure artifact upload descriptors", () => {
  it("is deterministic, session-bound, create-only, and row-free", async () => {
    const now = new Date("2026-08-28T00:00:00.000Z");
    const request = {
      contentSha256: "a".repeat(64),
      byteSize: 100,
      rowCount: 2,
      columns,
      parentArtifactIds: [],
      sourceReferences: ["datasource:ds_01HZX000000000000000000001"],
    };
    const first = await store.beginTableUpload({
      chatSessionId: "sess_01HZX000000000000000000001",
      request,
      now,
    });
    const retry = await store.beginTableUpload({
      chatSessionId: "sess_01HZX000000000000000000001",
      request,
      now,
    });
    const otherSession = await store.beginTableUpload({
      chatSessionId: "sess_01HZX000000000000000000002",
      request,
      now,
    });

    assert.equal(first.artifactId, retry.artifactId);
    assert.notEqual(first.artifactId, otherSession.artifactId);
    assert.match(first.artifactId, /^art_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.equal(first.upload.maximumSizeBytes, 5 * 1024 * 1024);
    assert.equal(first.upload.headers["If-None-Match"], "*");
    assert.equal(first.upload.headers["x-ms-blob-type"], "BlockBlob");
    assert.equal(Date.parse(first.upload.expiresAt) - now.getTime(), 60_000);
    const url = new URL(first.upload.url);
    assert.equal(url.searchParams.get("sp"), "c");
    assert.equal(url.searchParams.get("spr"), "https");
    assert.match(
      url.pathname,
      /\/artifacts\/sess_.*\/art_.*\/table\.v1\.jsonl$/,
    );
    assert.equal(JSON.stringify(first).includes('"rows"'), false);
  });

  it("rejects metadata over every declared boundary", () => {
    assert.equal(
      BeginTableArtifactUploadInputSchema.safeParse({
        contentSha256: "a".repeat(64),
        byteSize: artifactLimits.maxBytes + 1,
        rowCount: 1,
        columns,
        parentArtifactIds: [],
      }).success,
      false,
    );
    assert.equal(
      BeginTableArtifactUploadInputSchema.safeParse({
        contentSha256: "a".repeat(64),
        byteSize: 1,
        rowCount: artifactLimits.maxRows + 1,
        columns,
        parentArtifactIds: [],
      }).success,
      false,
    );
    assert.equal(
      BeginTableArtifactUploadInputSchema.safeParse({
        contentSha256: "a".repeat(64),
        byteSize: 1,
        rowCount: 1,
        columns: Array.from(
          { length: artifactLimits.maxColumns + 1 },
          (_, index) => ({
            name: `c${index}`,
            type: "number",
            nullable: false,
          }),
        ),
        parentArtifactIds: [],
      }).success,
      false,
    );
  });

  it("bounds each orphan scan page and resumes from its continuation token", async () => {
    const deleted: string[] = [];
    const old = new Date("2026-08-20T00:00:00.000Z");
    const recent = new Date("2026-08-28T00:00:00.000Z");
    const container = {
      listBlobsFlat() {
        return {
          async *[Symbol.asyncIterator]() {},
          async *byPage(input?: { continuationToken?: string }) {
            if (!input?.continuationToken) {
              yield {
                continuationToken: "second-page",
                segment: {
                  blobItems: [
                    {
                      name: "artifacts/recent",
                      properties: { lastModified: recent },
                    },
                  ],
                },
              };
              return;
            }
            assert.equal(input.continuationToken, "second-page");
            yield {
              segment: {
                blobItems: [
                  {
                    name: "artifacts/old-orphan",
                    properties: { lastModified: old },
                  },
                ],
              },
            };
          },
        };
      },
      getBlobClient(name: string) {
        const leaseId = `lease-${name}`;
        return {
          getBlobLeaseClient() {
            return {
              leaseId,
              async acquireLease() {},
              async renewLease() {},
              async releaseLease() {},
            };
          },
          async getProperties(input?: { conditions?: { leaseId?: string } }) {
            assert.equal(input?.conditions?.leaseId, leaseId);
            return { metadata: {} };
          },
          async delete(input: { conditions?: { leaseId?: string } }) {
            assert.equal(input.conditions?.leaseId, leaseId);
            deleted.push(name);
          },
        };
      },
    };
    const service = {
      getContainerClient: () => container,
    } as unknown as BlobServiceClient;
    const pagedStore = new ArtifactStore(
      {
        accountName: "dummy42account",
        accountKey: Buffer.alloc(32, 42).toString("base64"),
        container: "dummy42",
      },
      service,
      { analysisArtifactBlobExists: async () => false },
    );
    const cleanupInput = {
      olderThan: new Date("2026-08-27T00:00:00.000Z"),
      limit: 1,
    };
    assert.equal(await pagedStore.cleanupOrphanUploads(cleanupInput), 0);
    assert.equal(await pagedStore.cleanupOrphanUploads(cleanupInput), 1);
    assert.deepEqual(deleted, ["artifacts/old-orphan"]);
  });

  it("holds an infinite lease after hook success while COMMIT remains unresolved beyond 30 seconds", async (context) => {
    context.mock.timers.enable({
      apis: ["Date"],
      now: new Date("2026-08-28T00:00:00.000Z"),
    });
    const table = serializeCanonicalTableV1({
      columns: [{ name: "value", type: "integer", nullable: false }],
      rows: [{ value: 42 }],
    });
    const state = leaseBackedAzure(table.bytes);
    let hookSucceeded!: () => void;
    let releaseCommit!: () => void;
    const hooked = new Promise<void>((resolve) => (hookSucceeded = resolve));
    const release = new Promise<void>((resolve) => (releaseCommit = resolve));
    let invalidations = 0;
    const racingStore = new ArtifactStore(
      {
        accountName: "dummy42account",
        accountKey: Buffer.alloc(32, 42).toString("base64"),
        container: "dummy42",
      },
      state.service,
      {
        getReadyAnalysisArtifacts: async () => [],
        getAnalysisArtifact: async () => null,
        listAnalysisArtifactParents: async () => [],
        analysisArtifactBlobExists: async () => false,
        commitTableArtifact: (async (
          input: Record<string, unknown>,
          hooks: { beforeTransactionCommit?: () => Promise<void> },
        ) => {
          await hooks.beforeTransactionCommit?.();
          hookSucceeded();
          await release;
          return artifactFromCommit(input);
        }) as never,
        markAnalysisArtifactLeaseLost: async () => {
          invalidations += 1;
          return true;
        },
      },
    );
    const begin = await racingStore.beginTableUpload({
      chatSessionId: "sess_01HZX000000000000000000001",
      request: {
        contentSha256: table.contentSha256,
        byteSize: table.byteSize,
        rowCount: table.rowCount,
        columns: table.columns,
        parentArtifactIds: [],
        sourceReferences: [],
      },
    });
    state.name = new URL(begin.upload.url).pathname
      .split("/")
      .slice(2)
      .map(decodeURIComponent)
      .join("/");
    const finalize = racingStore.finalizeTable({
      chatSessionId: "sess_01HZX000000000000000000001",
      request: {
        artifactId: begin.artifactId,
        contentSha256: table.contentSha256,
        parentArtifactIds: [],
        sourceReferences: [],
      },
    });
    await hooked;
    context.mock.timers.tick(40_001);
    assert.equal(state.activeLeaseDuration, -1);
    assert.equal(
      await racingStore.cleanupOrphanUploads({
        olderThan: new Date(Date.now() + 1),
        staleFinalizationBefore: new Date(Date.now() - 60 * 60_000),
        limit: 1,
      }),
      0,
    );
    assert.equal(state.deleted, false);
    assert.equal(state.breakCalls, 0);
    releaseCommit();
    await finalize;
    assert.equal(invalidations, 0);
    assert.equal(state.activeLease, undefined);
  });

  it("never breaks a recent active infinite finalization lease", async () => {
    const now = new Date("2026-08-28T00:00:00.000Z");
    const state = leaseBackedAzure(Buffer.from("unused"));
    state.name = "artifacts/recent-active/table.v1.jsonl";
    state.seedInfiniteLease(now);
    const racingStore = new ArtifactStore(
      {
        accountName: "dummy42account",
        accountKey: Buffer.alloc(32, 42).toString("base64"),
        container: "dummy42",
      },
      state.service,
      { analysisArtifactBlobExists: async () => false },
    );
    assert.equal(
      await racingStore.cleanupOrphanUploads({
        olderThan: new Date("2026-08-29T00:00:00.000Z"),
        staleFinalizationBefore: new Date("2026-08-27T23:00:00.000Z"),
        limit: 1,
      }),
      0,
    );
    assert.equal(state.deleted, false);
    assert.equal(state.breakCalls, 0);
  });

  it("breaks, reacquires, and deletes only a stale infinite orphan lease", async () => {
    const state = leaseBackedAzure(Buffer.from("unused"));
    state.name = "artifacts/stale-crash/table.v1.jsonl";
    state.seedInfiniteLease(new Date("2026-08-27T20:00:00.000Z"));
    let databaseChecks = 0;
    const racingStore = new ArtifactStore(
      {
        accountName: "dummy42account",
        accountKey: Buffer.alloc(32, 42).toString("base64"),
        container: "dummy42",
      },
      state.service,
      {
        analysisArtifactBlobBindingExists: async () => false,
        analysisArtifactBlobExists: async () => {
          databaseChecks += 1;
          return false;
        },
      },
    );
    assert.equal(
      await racingStore.cleanupOrphanUploads({
        olderThan: new Date("2026-08-29T00:00:00.000Z"),
        staleFinalizationBefore: new Date("2026-08-27T23:00:00.000Z"),
        limit: 1,
      }),
      1,
    );
    assert.equal(state.breakCalls, 1);
    assert.equal(databaseChecks >= 2, true);
    assert.equal(state.deleted, true);
  });

  it("recovers a stale exact committed lease without deleting bytes, then permits retention deletion", async () => {
    const artifactId = "art_01HZX000000000000000000001";
    const state = leaseBackedAzure(Buffer.from("committed"));
    state.name = `artifacts/sess_01HZX000000000000000000001/${artifactId}/table.v1.jsonl`;
    state.seedInfiniteLease(new Date("2026-08-27T20:00:00.000Z"));
    let marked = 0;
    const artifact = artifactFromCommit({
      artifactId,
      azureBlobName: state.name,
      azureETag: state.etag,
      columns: [],
    });
    const racingStore = new ArtifactStore(
      {
        accountName: "dummy42account",
        accountKey: Buffer.alloc(32, 42).toString("base64"),
        container: "dummy42",
      },
      state.service,
      {
        analysisArtifactBlobBindingExists: async (input) => {
          assert.deepEqual(input, {
            artifactId,
            azureBlobName: state.name,
            azureETag: state.etag,
          });
          return true;
        },
        analysisArtifactBlobExists: async () => true,
        listAnalysisArtifactsDueForCleanup: (async () => [artifact]) as never,
        markAnalysisArtifactCleanupCompleted: async (input) => {
          assert.equal(input.artifactId, artifactId);
          marked += 1;
          return true;
        },
      },
    );

    assert.equal(
      await racingStore.cleanupOrphanUploads({
        olderThan: new Date("2026-08-29T00:00:00.000Z"),
        staleFinalizationBefore: new Date("2026-08-27T23:00:00.000Z"),
        limit: 1,
      }),
      0,
    );
    assert.equal(state.breakCalls, 1);
    assert.equal(state.releaseCalls, 1);
    assert.equal(state.activeLease, undefined);
    assert.equal(state.deleted, false);

    assert.equal(await racingStore.cleanupRetainedArtifacts(1), 1);
    assert.equal(state.deleted, true);
    assert.equal(marked, 1);
  });

  it("does not break a stale lease for a mismatched committed generation", async () => {
    const artifactId = "art_01HZX000000000000000000001";
    const state = leaseBackedAzure(Buffer.from("mismatched"));
    state.name = `artifacts/sess_01HZX000000000000000000001/${artifactId}/table.v1.jsonl`;
    state.seedInfiniteLease(new Date("2026-08-27T20:00:00.000Z"));
    const racingStore = new ArtifactStore(
      {
        accountName: "dummy42account",
        accountKey: Buffer.alloc(32, 42).toString("base64"),
        container: "dummy42",
      },
      state.service,
      {
        analysisArtifactBlobBindingExists: async () => false,
        analysisArtifactBlobExists: async () => true,
      },
    );

    assert.equal(
      await racingStore.cleanupOrphanUploads({
        olderThan: new Date("2026-08-29T00:00:00.000Z"),
        staleFinalizationBefore: new Date("2026-08-27T23:00:00.000Z"),
        limit: 1,
      }),
      0,
    );
    assert.equal(state.breakCalls, 0);
    assert.equal(state.deleted, false);
    assert.notEqual(state.activeLease, undefined);
  });

  it("conditions the stale A break so a newer B lease remains locked", async () => {
    const artifactId = "art_01HZX000000000000000000001";
    const state = leaseBackedAzure(Buffer.from("newer-generation"));
    state.name = `artifacts/sess_01HZX000000000000000000001/${artifactId}/table.v1.jsonl`;
    state.seedInfiniteLease(new Date("2026-08-27T20:00:00.000Z"));
    const staleETag = state.etag;
    const recentStartedAt = new Date("2026-08-28T00:30:00.000Z");
    const racingStore = new ArtifactStore(
      {
        accountName: "dummy42account",
        accountKey: Buffer.alloc(32, 42).toString("base64"),
        container: "dummy42",
      },
      state.service,
      {
        analysisArtifactBlobBindingExists: async (input) => {
          assert.equal(input.azureETag, staleETag);
          state.replaceWithInfiniteLease(recentStartedAt);
          return true;
        },
        analysisArtifactBlobExists: async () => true,
      },
    );

    assert.equal(
      await racingStore.cleanupOrphanUploads({
        olderThan: new Date("2026-08-29T00:00:00.000Z"),
        staleFinalizationBefore: new Date("2026-08-27T23:00:00.000Z"),
        limit: 1,
      }),
      0,
    );
    assert.deepEqual(state.breakConditions, [staleETag]);
    assert.equal(state.breakCalls, 0);
    assert.notEqual(state.etag, staleETag);
    assert.equal(state.activeLeaseDuration, -1);
    assert.notEqual(state.activeLease, undefined);
    assert.equal(
      state.metadata.fortytwoFinalizationStartedAt,
      recentStartedAt.toISOString(),
    );
    assert.equal(state.deleted, false);
  });

  it("skips a leased retained artifact without starving later cleanup", async () => {
    const leased = leaseBackedAzure(Buffer.from("leased"));
    const later = leaseBackedAzure(Buffer.from("later"));
    const leasedId = "art_01HZX000000000000000000001";
    const laterId = "art_01HZX000000000000000000002";
    leased.name = `artifacts/sess_01HZX000000000000000000001/${leasedId}/table.v1.jsonl`;
    later.name = `artifacts/sess_01HZX000000000000000000001/${laterId}/table.v1.jsonl`;
    leased.seedInfiniteLease(new Date("2026-08-27T20:00:00.000Z"));
    const leasedContainer = leased.service.getContainerClient("dummy42");
    const laterContainer = later.service.getContainerClient("dummy42");
    const service = {
      getContainerClient: () => ({
        getBlobClient(name: string) {
          return name === leased.name
            ? leasedContainer.getBlobClient(name)
            : laterContainer.getBlobClient(name);
        },
      }),
    } as unknown as BlobServiceClient;
    const marked: string[] = [];
    const racingStore = new ArtifactStore(
      {
        accountName: "dummy42account",
        accountKey: Buffer.alloc(32, 42).toString("base64"),
        container: "dummy42",
      },
      service,
      {
        listAnalysisArtifactsDueForCleanup: (async () => [
          artifactFromCommit({
            artifactId: leasedId,
            azureBlobName: leased.name,
            azureETag: leased.etag,
            columns: [],
          }),
          artifactFromCommit({
            artifactId: laterId,
            azureBlobName: later.name,
            azureETag: later.etag,
            columns: [],
          }),
        ]) as never,
        markAnalysisArtifactCleanupCompleted: async (input) => {
          marked.push(input.artifactId);
          return true;
        },
      },
    );

    assert.equal(await racingStore.cleanupRetainedArtifacts(2), 1);
    assert.equal(leased.deleted, false);
    assert.equal(later.deleted, true);
    assert.deepEqual(marked, [laterId]);
  });

  it("preserves committed metadata across transient post-commit Azure failures", async () => {
    const table = serializeCanonicalTableV1({
      columns: [{ name: "value", type: "integer", nullable: false }],
      rows: [{ value: 99 }],
    });
    for (const failure of ["properties", "release"] as const) {
      const state = leaseBackedAzure(table.bytes);
      if (failure === "properties") state.failPropertiesAt = 4;
      else state.releaseErrorStatus = 503;
      let invalidations = 0;
      const resilientStore = new ArtifactStore(
        {
          accountName: "dummy42account",
          accountKey: Buffer.alloc(32, 42).toString("base64"),
          container: "dummy42",
        },
        state.service,
        {
          getReadyAnalysisArtifacts: async () => [],
          getAnalysisArtifact: async () => null,
          listAnalysisArtifactParents: async () => [],
          commitTableArtifact: (async (
            input: Record<string, unknown>,
            hooks: { beforeTransactionCommit?: () => Promise<void> },
          ) => {
            await hooks.beforeTransactionCommit?.();
            return artifactFromCommit(input);
          }) as never,
          markAnalysisArtifactLeaseLost: async () => {
            invalidations += 1;
            return true;
          },
        },
      );
      const begin = await resilientStore.beginTableUpload({
        chatSessionId: "sess_01HZX000000000000000000001",
        request: {
          contentSha256: table.contentSha256,
          byteSize: table.byteSize,
          rowCount: table.rowCount,
          columns: table.columns,
          parentArtifactIds: [],
          sourceReferences: [],
        },
      });
      state.name = new URL(begin.upload.url).pathname
        .split("/")
        .slice(2)
        .map(decodeURIComponent)
        .join("/");
      const receipt = await resilientStore.finalizeTable({
        chatSessionId: "sess_01HZX000000000000000000001",
        request: {
          artifactId: begin.artifactId,
          contentSha256: table.contentSha256,
          parentArtifactIds: [],
          sourceReferences: [],
        },
      });
      assert.equal(receipt.artifactId, begin.artifactId);
      assert.equal(invalidations, 0);
      assert.equal(state.activeLease === undefined, failure === "properties");
    }
  });

  it("invalidates committed metadata when infinite lease ownership is lost before response", async () => {
    const table = serializeCanonicalTableV1({
      columns: [{ name: "value", type: "integer", nullable: false }],
      rows: [{ value: 99 }],
    });
    const state = leaseBackedAzure(table.bytes);
    let invalidations = 0;
    const racingStore = new ArtifactStore(
      {
        accountName: "dummy42account",
        accountKey: Buffer.alloc(32, 42).toString("base64"),
        container: "dummy42",
      },
      state.service,
      {
        getReadyAnalysisArtifacts: async () => [],
        getAnalysisArtifact: async () => null,
        listAnalysisArtifactParents: async () => [],
        commitTableArtifact: (async (
          input: Record<string, unknown>,
          hooks: { beforeTransactionCommit?: () => Promise<void> },
        ) => {
          await hooks.beforeTransactionCommit?.();
          state.breakActiveLease();
          return artifactFromCommit(input);
        }) as never,
        markAnalysisArtifactLeaseLost: async () => {
          invalidations += 1;
          return true;
        },
      },
    );
    const begin = await racingStore.beginTableUpload({
      chatSessionId: "sess_01HZX000000000000000000001",
      request: {
        contentSha256: table.contentSha256,
        byteSize: table.byteSize,
        rowCount: table.rowCount,
        columns: table.columns,
        parentArtifactIds: [],
        sourceReferences: [],
      },
    });
    state.name = new URL(begin.upload.url).pathname
      .split("/")
      .slice(2)
      .map(decodeURIComponent)
      .join("/");
    await assert.rejects(
      racingStore.finalizeTable({
        chatSessionId: "sess_01HZX000000000000000000001",
        request: {
          artifactId: begin.artifactId,
          contentSha256: table.contentSha256,
          parentArtifactIds: [],
          sourceReferences: [],
        },
      }),
      /lease was lost/,
    );
    assert.equal(invalidations, 1);
  });

  it("does not commit metadata when orphan cleanup acquires the lease first", async () => {
    const table = serializeCanonicalTableV1({
      columns: [{ name: "value", type: "integer", nullable: false }],
      rows: [{ value: 7 }],
    });
    const state = leaseBackedAzure(table.bytes);
    let cleanupChecked!: () => void;
    let releaseCleanup!: () => void;
    const checked = new Promise<void>((resolve) => (cleanupChecked = resolve));
    const release = new Promise<void>((resolve) => (releaseCleanup = resolve));
    let commitCalls = 0;
    const racingStore = new ArtifactStore(
      {
        accountName: "dummy42account",
        accountKey: Buffer.alloc(32, 42).toString("base64"),
        container: "dummy42",
      },
      state.service,
      {
        getReadyAnalysisArtifacts: async () => [],
        getAnalysisArtifact: async () => null,
        listAnalysisArtifactParents: async () => [],
        analysisArtifactBlobExists: async () => {
          cleanupChecked();
          await release;
          return false;
        },
        commitTableArtifact: (async () => {
          commitCalls += 1;
          throw new Error("unexpected commit");
        }) as never,
      },
    );
    const begin = await racingStore.beginTableUpload({
      chatSessionId: "sess_01HZX000000000000000000001",
      request: {
        contentSha256: table.contentSha256,
        byteSize: table.byteSize,
        rowCount: table.rowCount,
        columns: table.columns,
        parentArtifactIds: [],
        sourceReferences: [],
      },
    });
    state.name = new URL(begin.upload.url).pathname
      .split("/")
      .slice(2)
      .map(decodeURIComponent)
      .join("/");
    const cleanup = racingStore.cleanupOrphanUploads({
      olderThan: new Date("2026-08-27T00:00:00.000Z"),
      limit: 1,
    });
    await checked;
    await assert.rejects(
      racingStore.finalizeTable({
        chatSessionId: "sess_01HZX000000000000000000001",
        request: {
          artifactId: begin.artifactId,
          contentSha256: table.contentSha256,
          parentArtifactIds: [],
          sourceReferences: [],
        },
      }),
      /Azure 4(?:09|12)/,
    );
    assert.equal(commitCalls, 0);
    releaseCleanup();
    assert.equal(await cleanup, 1);
    assert.equal(state.deleted, true);
  });
});

describe("chart artifact receipt finalization", () => {
  it("finalizes the shared sparse Python helper receipt and persists renderer defaults", async () => {
    const commits: Record<string, unknown>[] = [];
    const chartStore = chartReceiptStore(commits);

    const result = await chartStore.finalizeChartArtifact({
      chatSessionId: chartReceiptFixture.chatSessionId,
      request: chartReceiptFixture.request,
    });

    assert.equal(commits.length, 1);
    assert.equal(result.artifactId, commits[0]?.artifactId);
    assert.deepEqual(result.config, commits[0]?.chartConfig.config);
    assert.equal(result.config.selectedChartType, "scatter");
    assert.equal(result.config.gridLines, false);
    assert.equal(result.config.xAxisLabelRotation, "auto");
    assert.equal(
      Object.keys(result.config).length >
        Object.keys(chartReceiptFixture.request.config).length,
      true,
    );
  });

  it("rejects a valid but tampered sparse config when its receipt hash is unchanged", async () => {
    const chartStore = chartReceiptStore([]);
    const scatterAxis = chartReceiptFixture.request.config
      .scatterAxis as Record<string, unknown>;

    await assert.rejects(
      chartStore.finalizeChartArtifact({
        chatSessionId: chartReceiptFixture.chatSessionId,
        request: {
          ...chartReceiptFixture.request,
          config: {
            ...chartReceiptFixture.request.config,
            scatterAxis: { ...scatterAxis, tooltip: [] },
          },
        },
      }),
      /receipt hash is invalid/,
    );
  });

  it("gives sparse and explicitly defaulted receipts the same normalized identity", async () => {
    const commits: Record<string, unknown>[] = [];
    const chartStore = chartReceiptStore(commits);
    const normalizedConfig = validateChartConfigV1({
      config: chartReceiptFixture.request.config,
      columns: chartReceiptFixture.source.columns,
      rowCount: chartReceiptFixture.source.rowCount,
    });
    const defaultedRequest = {
      ...chartReceiptFixture.request,
      config: normalizedConfig,
      receiptSha256: chartReceiptSha256({
        chatSessionId: chartReceiptFixture.chatSessionId,
        request: { ...chartReceiptFixture.request, config: normalizedConfig },
      }),
    };

    const sparse = await chartStore.finalizeChartArtifact({
      chatSessionId: chartReceiptFixture.chatSessionId,
      request: chartReceiptFixture.request,
    });
    const defaulted = await chartStore.finalizeChartArtifact({
      chatSessionId: chartReceiptFixture.chatSessionId,
      request: defaultedRequest,
    });

    assert.equal(commits.length, 2);
    assert.equal(defaulted.artifactId, sparse.artifactId);
    assert.equal(commits[1]?.contentSha256, commits[0]?.contentSha256);
    assert.deepEqual(commits[1]?.chartConfig, commits[0]?.chartConfig);
    assert.deepEqual(defaulted.config, sparse.config);
  });
});

function azureError(statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(`Azure ${statusCode}`), { statusCode });
}

function leaseBackedAzure(bytes: Buffer) {
  const state: {
    name: string;
    deleted: boolean;
    activeLease?: string;
    activeLeaseDuration?: number;
    leaseExpiresAt?: number;
    renewalCount: number;
    breakCalls: number;
    breakConditions: (string | undefined)[];
    releaseCalls: number;
    propertiesCalls: number;
    failPropertiesAt?: number;
    releaseErrorStatus?: number;
    metadata: Record<string, string>;
    etag: string;
    lastModified: Date;
    seedInfiniteLease: (startedAt: Date) => void;
    replaceWithInfiniteLease: (startedAt: Date) => void;
    breakActiveLease: () => void;
    service: BlobServiceClient;
  } = {
    name: "",
    deleted: false,
    renewalCount: 0,
    breakCalls: 0,
    breakConditions: [],
    releaseCalls: 0,
    propertiesCalls: 0,
    metadata: {},
    etag: '"etag-1"',
    lastModified: new Date("2026-08-20T00:00:00.000Z"),
    seedInfiniteLease: (startedAt) => {
      state.activeLease = `seeded-${++sequence}`;
      state.activeLeaseDuration = -1;
      state.leaseExpiresAt = Number.POSITIVE_INFINITY;
      state.metadata.fortytwoFinalizationStartedAt = startedAt.toISOString();
    },
    replaceWithInfiniteLease: (startedAt) => {
      state.activeLease = `replacement-${++sequence}`;
      state.activeLeaseDuration = -1;
      state.leaseExpiresAt = Number.POSITIVE_INFINITY;
      state.metadata.fortytwoFinalizationStartedAt = startedAt.toISOString();
      state.etag = `"etag-${++sequence}"`;
    },
    breakActiveLease: () => {
      state.activeLease = undefined;
      state.activeLeaseDuration = undefined;
      state.leaseExpiresAt = undefined;
    },
    service: undefined as unknown as BlobServiceClient,
  };
  let sequence = 0;
  const expireLease = () => {
    if (
      state.activeLease &&
      state.leaseExpiresAt !== undefined &&
      Date.now() >= state.leaseExpiresAt
    ) {
      state.activeLease = undefined;
      state.activeLeaseDuration = undefined;
      state.leaseExpiresAt = undefined;
    }
  };
  const blob = {
    getBlobLeaseClient() {
      let ownLease: string | undefined;
      return {
        get leaseId() {
          return ownLease ?? "";
        },
        async acquireLease(duration: number) {
          expireLease();
          if (state.deleted) throw azureError(404);
          if (state.activeLease) throw azureError(409);
          ownLease = `lease-${++sequence}`;
          state.activeLease = ownLease;
          state.activeLeaseDuration = duration;
          state.leaseExpiresAt =
            duration === -1
              ? Number.POSITIVE_INFINITY
              : Date.now() + duration * 1_000;
        },
        async renewLease() {
          expireLease();
          if (!ownLease || state.activeLease !== ownLease)
            throw azureError(412);
          state.renewalCount += 1;
          state.leaseExpiresAt =
            state.activeLeaseDuration === -1
              ? Number.POSITIVE_INFINITY
              : Date.now() + 30_000;
        },
        async releaseLease() {
          expireLease();
          if (state.activeLease !== ownLease) throw azureError(412);
          if (state.releaseErrorStatus !== undefined) {
            throw azureError(state.releaseErrorStatus);
          }
          state.releaseCalls += 1;
          state.activeLease = undefined;
          state.activeLeaseDuration = undefined;
          state.leaseExpiresAt = undefined;
        },
        async breakLease(
          _breakPeriod?: number,
          options?: { conditions?: { ifMatch?: string } },
        ) {
          expireLease();
          if (!state.activeLease) throw azureError(409);
          state.breakConditions.push(options?.conditions?.ifMatch);
          if (
            options?.conditions?.ifMatch !== undefined &&
            options.conditions.ifMatch !== state.etag
          ) {
            throw azureError(412);
          }
          state.breakCalls += 1;
          state.activeLease = undefined;
          state.activeLeaseDuration = undefined;
          state.leaseExpiresAt = undefined;
        },
      };
    },
    async getProperties(input?: {
      conditions?: { leaseId?: string; ifMatch?: string };
    }) {
      state.propertiesCalls += 1;
      if (state.propertiesCalls === state.failPropertiesAt) {
        throw azureError(503);
      }
      expireLease();
      if (state.deleted) throw azureError(404);
      if (input?.conditions?.leaseId !== undefined) {
        if (input.conditions.leaseId !== state.activeLease)
          throw azureError(412);
      }
      if (
        input?.conditions?.ifMatch !== undefined &&
        input.conditions.ifMatch !== state.etag
      ) {
        throw azureError(412);
      }
      return {
        etag: state.etag,
        contentLength: bytes.byteLength,
        contentType: "application/x-ndjson; charset=utf-8",
        metadata: { ...state.metadata },
        lastModified: state.lastModified,
        leaseDuration:
          state.activeLeaseDuration === -1
            ? "infinite"
            : state.activeLease
              ? "fixed"
              : undefined,
        leaseStatus: state.activeLease ? "locked" : "unlocked",
      };
    },
    async setMetadata(
      metadata: Record<string, string>,
      input?: { conditions?: { ifMatch?: string } },
    ) {
      if (state.activeLease) throw azureError(412);
      if (input?.conditions?.ifMatch !== state.etag) throw azureError(412);
      state.metadata = { ...metadata };
      state.etag = `"etag-${++sequence}"`;
      state.lastModified = new Date(Date.now());
      return { etag: state.etag };
    },
    async download(
      _offset: number,
      _count: undefined,
      input: { conditions?: { leaseId?: string; ifMatch?: string } },
    ) {
      expireLease();
      if (input.conditions?.leaseId !== state.activeLease)
        throw azureError(412);
      assert.equal(input.conditions?.ifMatch, state.etag);
      return { readableStreamBody: Readable.from([bytes]) };
    },
    async delete(input: {
      conditions?: { leaseId?: string; ifMatch?: string };
    }) {
      expireLease();
      if (state.activeLease) {
        if (input.conditions?.leaseId !== state.activeLease)
          throw azureError(412);
      } else if (input.conditions?.leaseId !== undefined) {
        throw azureError(412);
      }
      if (
        input.conditions?.ifMatch !== undefined &&
        input.conditions.ifMatch !== state.etag
      ) {
        throw azureError(412);
      }
      state.deleted = true;
      state.activeLease = undefined;
      state.activeLeaseDuration = undefined;
      state.leaseExpiresAt = undefined;
    },
  };
  const container = {
    getBlobClient: () => blob,
    listBlobsFlat() {
      return {
        async *[Symbol.asyncIterator]() {},
        async *byPage() {
          yield {
            segment: {
              blobItems: [
                {
                  name: state.name,
                  properties: {
                    lastModified: new Date("2026-08-20T00:00:00Z"),
                  },
                },
              ],
            },
          };
        },
      };
    },
  };
  state.service = {
    getContainerClient: () => container,
  } as unknown as BlobServiceClient;
  return state;
}

function artifactFromCommit(input: Record<string, unknown>) {
  return {
    ...input,
    id: input.artifactId,
    kind: "table",
    schemaVersion: "table.v1",
    status: "ready",
    title: input.title ?? null,
    description: null,
    columnCount: (input.columns as unknown[]).length,
    chartConfig: null,
    deletedAt: null,
    retentionExpiresAt: null,
    cleanupCompletedAt: null,
    createdAt: new Date(),
  };
}

function chartReceiptStore(commits: Record<string, unknown>[]) {
  const source = {
    ...chartReceiptFixture.source,
    kind: "table",
    provenance: { dataSourceIds: [] },
  };
  return new ArtifactStore(
    {
      accountName: "dummy42account",
      accountKey: Buffer.alloc(32, 42).toString("base64"),
      container: "dummy42",
    },
    undefined,
    {
      getAnalysisArtifact: (async () => source) as never,
      commitChartArtifact: (async (input: Record<string, unknown>) => {
        commits.push(input);
        return { id: input.artifactId };
      }) as never,
    },
  );
}

function chartReceiptSha256(input: {
  chatSessionId: string;
  request: Omit<typeof chartReceiptFixture.request, "receiptSha256"> & {
    receiptSha256?: string;
  };
}) {
  const request = { ...input.request };
  delete request.receiptSha256;
  return createHash("sha256")
    .update(
      JSON.stringify(
        stableJsonValueForTest({ sessionId: input.chatSessionId, ...request }),
      ),
      "utf8",
    )
    .digest("hex");
}

function stableJsonValueForTest(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValueForTest);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, stableJsonValueForTest(record[key])]),
    );
  }
  return value;
}
