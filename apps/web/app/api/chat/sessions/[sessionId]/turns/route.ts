import {
  ApiInputError,
  apiError,
  readTurnInput,
  trueForgeClient,
  validId,
} from "../../../../../../lib/server/chat-backend";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ sessionId: string }> };

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const { sessionId } = await context.params;
    const search = new URL(request.url).searchParams;
    const value = search.get("limit");
    const limit = value === null ? 25 : Number(value);
    if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
      throw new ApiInputError("limit must be an integer from 1 to 25.");
    }
    const pageToken = search.get("pageToken") || undefined;
    if (pageToken && pageToken.length > 2_048) {
      throw new ApiInputError("pageToken is invalid.");
    }
    const page = await trueForgeClient().sessions.listTurns(
      validId(sessionId, "session id"),
      { limit, pageToken },
    );
    return Response.json({
      data: page.data,
      pagination: page.response.pagination,
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const { sessionId } = await context.params;
    const userMessage = await readTurnInput(request);
    const turn = await trueForgeClient().sessions.createTurn(
      validId(sessionId, "session id"),
      { input: [userMessage] },
    );
    return Response.json(turn, { status: 202 });
  } catch (error) {
    return apiError(error);
  }
}
