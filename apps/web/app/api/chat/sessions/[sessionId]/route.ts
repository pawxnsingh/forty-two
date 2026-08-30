import {
  apiError,
  applicationSession,
  deleteApplicationSession,
  trueForgeClient,
  validId,
} from "../../../../../lib/server/chat-backend";
import { listChatSessionDataSources } from "@forty-two/db";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ sessionId: string }> };

export async function GET(
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const { sessionId } = await context.params;
    const application = await applicationSession(
      validId(sessionId, "session id"),
    );
    const runtimeSession = await trueForgeClient().sessions.get(
      application.trueforgeSessionId!,
    );
    const dataSources = await listChatSessionDataSources({
      chatSessionId: application.id,
    });
    const runtimeData: Record<string, unknown> = { ...runtimeSession.data };
    Reflect.deleteProperty(runtimeData, "id");
    return Response.json({
      data: {
        ...runtimeData,
        id: validId(sessionId, "session id"),
        dataSources: dataSources.map((source) => ({
          id: source.id,
          name: source.name,
          connectorType: source.connectorType,
          status: source.status,
        })),
      },
    });
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
    await deleteApplicationSession(validId(sessionId, "session id"));
    return new Response(null, { status: 204 });
  } catch (error) {
    return apiError(error);
  }
}
