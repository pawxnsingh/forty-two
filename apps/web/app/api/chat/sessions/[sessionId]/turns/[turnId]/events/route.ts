import {
  apiError,
  listAllEvents,
  trueforgeSessionId,
  validId,
} from "../../../../../../../../lib/server/chat-backend";
import { normalizedTurnHistoryPayload } from "../../../../../../../../lib/server/turn-events";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ sessionId: string; turnId: string }>;
};

export async function GET(
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const { sessionId, turnId } = await context.params;
    const safeSessionId = validId(sessionId, "session id");
    const safeTurnId = validId(turnId, "turn id");
    const events = await listAllEvents(
      await trueforgeSessionId(safeSessionId),
      safeTurnId,
    );
    const turnEvents = events.filter((item) => item.turnId === safeTurnId);
    return Response.json(normalizedTurnHistoryPayload(turnEvents));
  } catch (error) {
    return apiError(error);
  }
}
