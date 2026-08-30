import {
  completeFileDataSource,
  dataSourceApiError,
} from "../../../../../lib/server/data-sources/file-service";
import { readJsonRequest } from "../../../../../lib/server/data-sources/request";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const { id } = await context.params;
    const data = await completeFileDataSource(
      id,
      await readJsonRequest(request, { allowEmpty: true }),
    );
    return Response.json({ data });
  } catch (error) {
    return dataSourceApiError(error);
  }
}
