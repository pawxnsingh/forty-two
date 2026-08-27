import {
  apiError,
  listAllEvents,
  validId,
} from "../../../../../../../../lib/server/chat-backend";

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
    const events = await listAllEvents(safeSessionId, safeTurnId);
    return Response.json({
      data: events.filter((item) => item.turnId === safeTurnId),
    });
  } catch (error) {
    return apiError(error);
  }
}
