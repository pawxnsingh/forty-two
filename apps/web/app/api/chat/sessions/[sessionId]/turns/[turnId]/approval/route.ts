import {
  apiError,
  resolveSqlChangeApproval,
  validId,
} from "../../../../../../../../lib/server/chat-backend";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ sessionId: string; turnId: string }>;
};

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const { sessionId, turnId } = await context.params;
    const safeSessionId = validId(sessionId, "session id");
    const safeTurnId = validId(turnId, "turn id");
    const resumed = await resolveSqlChangeApproval(
      safeSessionId,
      safeTurnId,
      request,
    );
    return Response.json(
      {
        ...resumed,
        data: { ...resumed.data, sessionId: safeSessionId },
      },
      { status: 202 },
    );
  } catch (error) {
    return apiError(error);
  }
}
