import {
  artifactApiError,
  downloadPublicArtifact,
} from "../../../../../../../../lib/server/artifacts/service";

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
    const result = await downloadPublicArtifact(request, sessionId, artifactId);
    const body = result.bytes.buffer.slice(
      result.bytes.byteOffset,
      result.bytes.byteOffset + result.bytes.byteLength,
    ) as ArrayBuffer;
    return new Response(body, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Content-Length": String(result.bytes.byteLength),
        ETag: result.etag,
        Digest: `sha-256=${Buffer.from(result.sha256, "hex").toString("base64")}`,
        "Cache-Control": "private, no-store",
        "Content-Disposition": `attachment; filename="${artifactId}.table.v1.jsonl"`,
      },
    });
  } catch (error) {
    return artifactApiError(error);
  }
}
