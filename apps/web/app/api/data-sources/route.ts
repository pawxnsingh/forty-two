import {
  dataSourceApiError,
  listPublicDataSources,
} from "../../../lib/server/data-sources/file-service";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  try {
    const page = await listPublicDataSources(new URL(request.url).searchParams);
    return Response.json({
      data: page.data,
      pagination: { nextPageToken: page.nextPageToken },
    });
  } catch (error) {
    return dataSourceApiError(error);
  }
}
