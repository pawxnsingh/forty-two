import {
  ApiInputError,
  apiError,
  parseWaitTimeout,
  validId,
  waitForTurn,
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
    const text = await request.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      throw new ApiInputError("Request body must be valid JSON.");
    }
    const turn = await waitForTurn(
      validId(sessionId, "session id"),
      validId(turnId, "turn id"),
      parseWaitTimeout(body),
    );
    return Response.json({ data: turn });
  } catch (error) {
    return apiError(error);
  }
}
