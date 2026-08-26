const DEFAULT_QUERY_TIMEOUT_MS = 60_000;
export const MAX_QUERY_TIMEOUT_MS = 600_000;

export function resolveQueryTimeout(
  timeout: number | undefined,
  defaultTimeout = DEFAULT_QUERY_TIMEOUT_MS,
): number {
  const resolved = timeout ?? defaultTimeout;

  if (
    !Number.isFinite(resolved) ||
    !Number.isInteger(resolved) ||
    resolved <= 0 ||
    resolved > MAX_QUERY_TIMEOUT_MS
  ) {
    throw new Error(
      `Query timeout must be a positive integer no greater than ${MAX_QUERY_TIMEOUT_MS}ms`,
    );
  }

  return resolved;
}
