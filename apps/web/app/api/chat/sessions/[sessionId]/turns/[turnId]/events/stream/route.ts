import {
  ApiInputError,
  apiError,
  trueForgeClient,
  trueforgeSessionId,
  validId,
} from "../../../../../../../../../lib/server/chat-backend";
import {
  createNormalizedTurnEventStream,
  turnStreamCursor,
} from "../../../../../../../../../lib/server/turn-event-stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ sessionId: string; turnId: string }>;
};

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const { sessionId, turnId } = await context.params;
    let cursor;
    try {
      cursor = turnStreamCursor(request);
    } catch (error) {
      throw new ApiInputError(
        error instanceof Error ? error.message : "Invalid stream cursor.",
      );
    }
    const stream = await trueForgeClient().sessions.subscribeToTurn(
      await trueforgeSessionId(validId(sessionId, "session id")),
      validId(turnId, "turn id"),
      {},
      { abortSignal: request.signal, timeoutInSeconds: 300 },
    );
    const body = createNormalizedTurnEventStream(stream.withMetadata(), {
      signal: request.signal,
      resume: cursor.resume,
    });
    return new Response(body, {
      headers: {
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no",
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
