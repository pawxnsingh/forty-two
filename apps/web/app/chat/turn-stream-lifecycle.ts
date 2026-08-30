interface StreamEvent {
  type: string;
}

interface ReconcileStreamErrorOptions<T extends StreamEvent> {
  loadHistory: () => Promise<T[]>;
  applyTerminalHistory: (events: T[]) => void;
  closeTerminalStream: () => void;
}

export async function reconcileStreamError<T extends StreamEvent>({
  loadHistory,
  applyTerminalHistory,
  closeTerminalStream,
}: ReconcileStreamErrorOptions<T>): Promise<void> {
  let events: T[];
  try {
    events = await loadHistory();
  } catch {
    // Preserve the live state while the browser's EventSource reconnects.
    return;
  }

  const terminal = events.some(
    (event) => event.type === "turn.completed" || event.type === "turn.failed",
  );
  if (!terminal) return;
  applyTerminalHistory(events);
  closeTerminalStream();
}
