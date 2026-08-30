import type { EvidenceMeaning } from "./contract.js";

export const evidenceStatus = {
  verified: "success",
  processing: "info",
  attention: "warning",
  failed: "danger",
  unknown: "neutral",
} as const satisfies Record<EvidenceMeaning, "success" | "warning" | "danger" | "info" | "neutral">;
