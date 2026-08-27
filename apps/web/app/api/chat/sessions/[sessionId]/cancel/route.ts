import {
  apiError,
  trueForgeClient,
  validId,
} from "../../../../../../lib/server/chat-backend";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ sessionId: string }> };

export async function POST(
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const { sessionId } = await context.params;
    const result = await trueForgeClient().sessions.cancel(
      validId(sessionId, "session id"),
    );
    return Response.json(result);
  } catch (error) {
    return apiError(error);
  }
}
