import {
  dataSourceApiError,
  deletePublicDataSource,
  getPublicDataSource,
} from "../../../../lib/server/data-sources/file-service";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const { id } = await context.params;
    return Response.json({ data: await getPublicDataSource(id) });
  } catch (error) {
    return dataSourceApiError(error);
  }
}

export async function DELETE(
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const { id } = await context.params;
    await deletePublicDataSource(id);
    return new Response(null, { status: 204 });
  } catch (error) {
    return dataSourceApiError(error);
  }
}
