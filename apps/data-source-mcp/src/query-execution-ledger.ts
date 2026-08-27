export interface QueryExecutionRecord {
  requestId: string;
  dataSource: string;
  rows: Record<string, unknown>[];
  recordedAt: string;
}

const MAX_RECORDS = 1_000;
const RECORD_TTL_MS = 10 * 60_000;

/** Short-lived, authenticated server-side evidence for integration verification. */
export class QueryExecutionLedger {
  private readonly records = new Map<
    string,
    QueryExecutionRecord & { expiresAt: number }
  >();

  record(
    requestId: string,
    dataSource: string,
    rows: Record<string, unknown>[],
  ): QueryExecutionRecord {
    this.prune();
    if (this.records.has(requestId)) {
      throw new Error(`Query requestId '${requestId}' has already been used`);
    }
    const record = {
      requestId,
      dataSource,
      rows: rows.slice(0, 10),
      recordedAt: new Date().toISOString(),
      expiresAt: Date.now() + RECORD_TTL_MS,
    };
    this.records.set(requestId, record);
    this.prune();
    return record;
  }

  get(requestId: string): QueryExecutionRecord | undefined {
    this.prune();
    const record = this.records.get(requestId);
    if (!record) return undefined;
    const { expiresAt: _expiresAt, ...publicRecord } = record;
    return publicRecord;
  }

  private prune(): void {
    const now = Date.now();
    for (const [requestId, record] of this.records) {
      if (record.expiresAt <= now) this.records.delete(requestId);
    }
    while (this.records.size > MAX_RECORDS) {
      const oldest = this.records.keys().next().value;
      if (typeof oldest !== "string") break;
      this.records.delete(oldest);
    }
  }
}
