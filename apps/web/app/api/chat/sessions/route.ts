import {
  ApiInputError,
  apiError,
  createApplicationSession,
} from "../../../../lib/server/chat-backend";
import { listChatSessions } from "@forty-two/db";
import { ChatSessionStatusSchema } from "@forty-two/db";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  try {
    const search = new URL(request.url).searchParams;
    const limit = parseLimit(search.get("limit"));
    const offset = parsePageToken(search.get("pageToken"));
    const rawStatus = search.get("status");
    const status =
      rawStatus === null ? null : ChatSessionStatusSchema.safeParse(rawStatus);
    if (status && !status.success) {
      throw new ApiInputError("status is invalid.");
    }
    const sessions = await listChatSessions({
      limit: limit + 1,
      offset,
      statuses: status?.success ? [status.data] : undefined,
    });
    const hasMore = sessions.length > limit;
    return Response.json({
      data: sessions.slice(0, limit).map((session) => ({
        id: session.id,
        status: session.status,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      })),
      pagination: {
        nextPageToken: hasMore ? String(offset + limit) : null,
      },
    });
  } catch (error) {
    return apiError(error);
  }
}

function parsePageToken(value: string | null): number {
  if (value === null) return 0;
  if (!/^\d+$/.test(value)) {
    throw new ApiInputError("pageToken is invalid.");
  }
  const offset = Number(value);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new ApiInputError("pageToken is invalid.");
  }
  return offset;
}

export async function POST(request: Request): Promise<Response> {
  try {
    const session = await createApplicationSession(request);
    return Response.json({ data: session }, { status: 201 });
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
