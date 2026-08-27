import {
  ApiInputError,
  agentName,
  apiError,
  trueForgeClient,
} from "../../../../lib/server/chat-backend";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  try {
    const search = new URL(request.url).searchParams;
    const limit = parseLimit(search.get("limit"));
    const pageToken = parsePageToken(search.get("pageToken"));
    const page = await trueForgeClient().sessions.list({ limit, pageToken });
    return Response.json({
      data: page.data,
      pagination: page.response.pagination,
    });
  } catch (error) {
    return apiError(error);
  }
}

function parsePageToken(value: string | null): string | undefined {
  if (value === null) return undefined;
  if (!value || value.length > 2_048) {
    throw new ApiInputError("pageToken is invalid.");
  }
  return value;
}

export async function POST(): Promise<Response> {
  try {
    const session = await trueForgeClient().sessions.create({
      agent: { name: agentName() },
    });
    return Response.json(session, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}

function parseLimit(value: string | null): number {
  if (value === null) return 25;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
    throw new ApiInputError("limit must be an integer from 1 to 25.");
  }
  return limit;
}
