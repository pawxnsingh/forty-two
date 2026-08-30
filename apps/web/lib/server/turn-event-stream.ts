import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";

import {
  createTurnEventState,
  normalizeTurnEvent,
  type NormalizedTurnEvent,
} from "./turn-events";

const MAX_SEQUENCE_NUMBER = Number.MAX_SAFE_INTEGER;
const LAST_SOURCE_EVENT_INDEX = Number.MAX_SAFE_INTEGER;
const CURSOR_PATTERN = /^(0|[1-9]\d*):(0|[1-9]\d*)$/;
const SEQUENCE_PATTERN = /^(0|[1-9]\d*)$/;

export interface UpstreamServerSentEvent<T> {
  data: T;
  id?: string;
  retry?: number;
  event?: string;
}

export interface TurnStreamCursor {
  /** Replay from the live-buffer start to rebuild normalization state. */
  resume?: { sequenceNumber: number; eventIndex: number };
}

export function turnStreamCursor(request: Request): TurnStreamCursor {
  const lastEventId = request.headers.get("last-event-id")?.trim();
  if (lastEventId) return parseLastEventId(lastEventId);

  const url = new URL(request.url);
  const camel = url.searchParams.get("afterSequenceNumber");
  const snake = url.searchParams.get("after_sequence_number");
  if (camel !== null && snake !== null && camel !== snake) {
    throw new Error("Conflicting stream resume cursors.");
  }
  const value = camel ?? snake;
  return value === null ? {} : nativeCursor(parseInteger(value));
}

function parseLastEventId(value: string): TurnStreamCursor {
  const product = CURSOR_PATTERN.exec(value);
  if (product) {
    return {
      resume: {
        sequenceNumber: parseInteger(product[1]!),
        eventIndex: parseInteger(product[2]!),
      },
    };
  }
  return nativeCursor(parseInteger(value));
}

function nativeCursor(sequenceNumber: number): TurnStreamCursor {
  return {
    resume: { sequenceNumber, eventIndex: LAST_SOURCE_EVENT_INDEX },
  };
}

function parseInteger(value: string): number {
  if (!SEQUENCE_PATTERN.test(value)) throw new Error("Invalid stream cursor.");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_SEQUENCE_NUMBER) {
    throw new Error("Invalid stream cursor.");
  }
  return parsed;
}

export function createNormalizedTurnEventStream(
  source: AsyncIterable<
    UpstreamServerSentEvent<TrueForgeApi.TurnStreamingEvent>
  >,
  options: { signal?: AbortSignal; resume?: TurnStreamCursor["resume"] } = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const state = createTurnEventState();
  const iterator = source[Symbol.asyncIterator]();
  let finished = false;
  let iteratorReturned = false;

  async function closeIterator(): Promise<void> {
    if (iteratorReturned) return;
    iteratorReturned = true;
    await iterator.return?.();
  }

  async function closeIteratorAfterSuccess(): Promise<void> {
    try {
      await closeIterator();
    } catch {
      // Upstream cleanup cannot replace a successfully completed stream.
    }
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return;
      try {
        while (!finished) {
          if (options.signal?.aborted) {
            finished = true;
            await closeIteratorAfterSuccess();
            controller.close();
            return;
          }
          const next = await iterator.next();
          if (options.signal?.aborted) {
            finished = true;
            await closeIteratorAfterSuccess();
            controller.close();
            return;
          }
          if (next.done) {
            finished = true;
            await closeIteratorAfterSuccess();
            controller.close();
            return;
          }
          const frames = encodeSourceEvent(next.value, state, options.resume);
          if (frames.length === 0) continue;
          controller.enqueue(encoder.encode(frames.join("")));
          if (next.value.data.type === "turn.done") {
            finished = true;
            await closeIteratorAfterSuccess();
            controller.close();
          }
          return;
        }
      } catch (error) {
        finished = true;
        try {
          await closeIterator();
        } catch {
          // Preserve the original next()/normalization failure.
        }
        if (options.signal?.aborted) controller.close();
        else controller.error(error);
      }
    },
    async cancel() {
      finished = true;
      await closeIteratorAfterSuccess();
    },
  });
}

function encodeSourceEvent(
  source: UpstreamServerSentEvent<TrueForgeApi.TurnStreamingEvent>,
  state: ReturnType<typeof createTurnEventState>,
  resume: TurnStreamCursor["resume"],
): string[] {
  const events = normalizeTurnEvent(source.data, state);
  const sequenceNumber = source.id ? parseSourceSequence(source.id) : undefined;
  return events.flatMap((event, eventIndex) => {
    if (
      resume &&
      sequenceNumber !== undefined &&
      (sequenceNumber < resume.sequenceNumber ||
        (sequenceNumber === resume.sequenceNumber &&
          eventIndex <= resume.eventIndex))
    ) {
      return [];
    }
    return [encodeSse(event, sequenceNumber, eventIndex)];
  });
}

function parseSourceSequence(value: string): number | undefined {
  try {
    return parseInteger(value);
  } catch {
    return undefined;
  }
}

function encodeSse(
  event: NormalizedTurnEvent,
  sequenceNumber: number | undefined,
  eventIndex: number,
): string {
  const id =
    sequenceNumber === undefined ? "" : `id: ${sequenceNumber}:${eventIndex}\n`;
  return `${id}event: ${eventCategory(event.type)}\ndata: ${JSON.stringify(event)}\n\n`;
}

function eventCategory(type: NormalizedTurnEvent["type"]): string {
  if (type.startsWith("assistant.")) return "assistant";
  if (type.startsWith("tool.")) return "tool";
  if (type.startsWith("approval.")) return "approval";
  if (type.startsWith("plan.")) return "plan";
  if (type.startsWith("artifact.")) return "artifact";
  return "turn";
}
