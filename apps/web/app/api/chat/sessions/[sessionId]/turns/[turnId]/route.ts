import {
  apiError,
  trueForgeClient,
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
      validId(sessionId, "session id"),
      validId(turnId, "turn id"),
    );
    return Response.json(turn);
  } catch (error) {
    return apiError(error);
  }
}
