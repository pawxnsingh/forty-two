import {
  artifactApiError,
  getPublicArtifact,
} from "../../../../../../../lib/server/artifacts/service";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ sessionId: string; artifactId: string }>;
};

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const { sessionId, artifactId } = await context.params;
    return Response.json(
      { data: await getPublicArtifact(request, sessionId, artifactId) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return artifactApiError(error);
  }
}
