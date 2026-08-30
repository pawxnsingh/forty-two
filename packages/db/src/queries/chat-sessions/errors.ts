export class ChatSessionDataSourceLimitError extends Error {
  constructor(
    readonly sourceCount: number,
    readonly maximumSourceCount: number,
  ) {
    super(
      `Chat session datasource count ${sourceCount} exceeds the maximum of ${maximumSourceCount}.`,
    );
    this.name = "ChatSessionDataSourceLimitError";
  }
}

export class ChatSessionDataSourceUnavailableError extends Error {
  constructor() {
    super("Every chat session datasource must exist and be ready.");
    this.name = "ChatSessionDataSourceUnavailableError";
  }
}

export class ChatSessionIdempotencyConflictError extends Error {
  constructor(readonly idempotencyKey: string) {
    super("The idempotency key was already used for a different request.");
    this.name = "ChatSessionIdempotencyConflictError";
  }
}
