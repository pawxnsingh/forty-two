import {
  apiError,
  deleteSessionResources,
  trueForgeClient,
  validId,
} from "../../../../../lib/server/chat-backend";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ sessionId: string }> };

export async function GET(
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const { sessionId } = await context.params;
    const session = await trueForgeClient().sessions.get(
      validId(sessionId, "session id"),
    );
    return Response.json(session);
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const { sessionId } = await context.params;
    await deleteSessionResources(validId(sessionId, "session id"));
    return new Response(null, { status: 204 });
  } catch (error) {
    return apiError(error);
  }
}
