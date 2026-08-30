import {
  artifactApiError,
  listPublicArtifacts,
} from "../../../../../../lib/server/artifacts/service";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ sessionId: string }> };

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const { sessionId } = await context.params;
    const data = await listPublicArtifacts(
      request,
      sessionId,
      new URL(request.url).searchParams,
    );
    return Response.json(
      { data },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return artifactApiError(error);
  }
}
