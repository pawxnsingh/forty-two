import {
  apiError,
  trueForgeClient,
  trueforgeSessionId,
  validId,
} from "../../../../../../../lib/server/chat-backend";

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
    const turn = await trueForgeClient().sessions.getTurn(
      await trueforgeSessionId(validId(sessionId, "session id")),
      validId(turnId, "turn id"),
    );
    return Response.json({
      ...turn,
      data: { ...turn.data, sessionId: validId(sessionId, "session id") },
    });
  } catch (error) {
    return apiError(error);
  }
}
