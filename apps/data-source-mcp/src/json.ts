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
  const message = safeToolErrorMessage(error);
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

function safeToolErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Data source operation failed.";
  if (
    /^(Query type |Only read-only queries are allowed|SELECT statements with INTO|Locking SELECT statements|Data source '[^']+' is not available$)/.test(
      error.message,
    )
  ) {
    return error.message;
  }
  return "Data source operation failed.";
}
