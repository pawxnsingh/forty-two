import {
  AnalysisArtifactSchema,
  type AnalysisArtifact,
} from "../../artifact-types.js";
import type { AnalysisArtifactRow } from "../../schema/analysis-artifacts.js";

export function parseAnalysisArtifact(
  row: AnalysisArtifactRow,
): AnalysisArtifact {
  return AnalysisArtifactSchema.parse(row);
}

export class ArtifactCommitConflictError extends Error {
  constructor(message = "Artifact retry does not match the committed artifact.") {
    super(message);
    this.name = "ArtifactCommitConflictError";
  }
}
