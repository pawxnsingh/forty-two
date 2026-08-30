export function toolSuccess(data: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

export function toolFailure(error: unknown) {
  const message = safeMessage(error);
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

function safeMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Plan operation failed.";
  if (
    error.name === "ZodError" ||
    error.name === "ChatSessionPlanUnavailableError" ||
    /^(A plan must be set|Plan item index )/.test(error.message)
  ) {
    return error.message;
  }
  return "Plan operation failed.";
}
