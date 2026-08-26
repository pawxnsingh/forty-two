export function toJsonSafe(value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString("base64");
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, toJsonSafe(nested)]),
    );
  }
  return value;
}

export function toolSuccess(data: unknown) {
  const structuredContent = toJsonSafe(data) as Record<string, unknown>;
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(structuredContent) },
    ],
    structuredContent,
  };
}

export function toolFailure(error: unknown) {
  const message =
    error instanceof Error ? error.message : "Unexpected data-source error";
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}
