import {
  dataSourceApiError,
  listPublicDataSources,
} from "../../../lib/server/data-sources/file-service";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  try {
    const data = await listPublicDataSources(new URL(request.url).searchParams);
    return Response.json({ data });
  } catch (error) {
    return dataSourceApiError(error);
  }
}
