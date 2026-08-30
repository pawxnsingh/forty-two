import {
  apiError,
  renewArtifactCapability,
  validId,
} from "../../../../../../../lib/server/chat-backend";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ sessionId: string }> };

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const { sessionId } = await context.params;
    return Response.json({
      data: await renewArtifactCapability(
        request,
        validId(sessionId, "session id"),
      ),
    });
  } catch (error) {
    return apiError(error);
  }
}
