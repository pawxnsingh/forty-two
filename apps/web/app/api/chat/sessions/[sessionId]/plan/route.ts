import { getChatSessionPlan } from "@forty-two/db";

import { apiError, validId } from "../../../../../../lib/server/chat-backend";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ sessionId: string }> };

export async function GET(
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const { sessionId } = await context.params;
    const snapshot = await getChatSessionPlan({
      chatSessionId: validId(sessionId, "session id"),
    });
    if (!snapshot) {
      return Response.json(
        { error: { message: "Chat session was not found." } },
        { status: 404 },
      );
    }
    return Response.json({
      data: {
        plan: snapshot.plan,
        revision: snapshot.revision,
        updatedAt: snapshot.updatedAt?.toISOString() ?? null,
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
