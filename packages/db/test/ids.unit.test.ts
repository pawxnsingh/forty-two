import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AnalysisArtifactIdSchema,
  DataSourceIdSchema,
  deriveAnalysisArtifactId,
  generateDataSourceId,
} from "../src/index.js";

describe("datasource ID generation", () => {
  it("generates unique ds_-prefixed ULIDs", () => {
    const first = generateDataSourceId();
    const second = generateDataSourceId();

    assert.match(first, /^ds_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.match(second, /^ds_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.notEqual(first, second);
    assert.equal(DataSourceIdSchema.parse(first), first);
  });

  it("rejects unprefixed and malformed IDs", () => {
    assert.equal(
      DataSourceIdSchema.safeParse("01ARZ3NDEKTSV4RRFFQ69G5FAV").success,
      false,
    );
    assert.equal(DataSourceIdSchema.safeParse("ds_not-a-ulid").success, false);
  });
});

describe("artifact ID derivation", () => {
  it("is deterministic, opaque, and identity-bound", () => {
    const first = deriveAnalysisArtifactId("session-a:hash-a");
    const retry = deriveAnalysisArtifactId("session-a:hash-a");
    const other = deriveAnalysisArtifactId("session-b:hash-a");
    assert.equal(first, retry);
    assert.notEqual(first, other);
    assert.match(first, /^art_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.equal(AnalysisArtifactIdSchema.parse(first), first);
  });
});
