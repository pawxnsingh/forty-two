export interface ApprovalState {
  decision: "allow" | "deny";
  status: "submitting" | "resolved";
}

export interface CursorPage<T> {
  data: T[];
  pagination: { nextPageToken: string | null };
}

export function sourceScopeLabel(
  sources: ReadonlyArray<{ name: string }>,
  fallback: string,
): string {
  if (sources.length === 1) return sources[0]!.name;
  if (sources.length > 1) return `${sources.length} sources`;
  return fallback;
}

export async function collectCursorPages<T>(
  loadPage: (pageToken: string | null) => Promise<CursorPage<T>>,
): Promise<T[]> {
  const data: T[] = [];
  const seenTokens = new Set<string>();
  let pageToken: string | null = null;

  do {
    const page = await loadPage(pageToken);
    data.push(...page.data);
    const next = page.pagination.nextPageToken;
    if (next && seenTokens.has(next)) {
      throw new Error("Pagination repeated a page token.");
    }
    if (next) seenTokens.add(next);
    pageToken = next;
  } while (pageToken);

  return data;
}

export function submittingApproval(
  current: ReadonlyMap<string, ApprovalState>,
  toolCallId: string,
  decision: ApprovalState["decision"],
) {
  return new Map(current).set(toolCallId, {
    decision,
    status: "submitting" as const,
  });
}

export function resolvedApproval(
  current: ReadonlyMap<string, ApprovalState>,
  toolCallId: string,
  decision: ApprovalState["decision"],
) {
  return new Map(current).set(toolCallId, {
    decision,
    status: "resolved" as const,
  });
}

export function retryableApproval(
  current: ReadonlyMap<string, ApprovalState>,
  toolCallId: string,
) {
  const next = new Map(current);
  next.delete(toolCallId);
  return next;
}
