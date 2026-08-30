import { dataSourceApiError } from "../../../../lib/server/data-sources/file-service";
import { registerDatabaseDataSource } from "../../../../lib/server/data-sources/database-service";
import { readJsonRequest } from "../../../../lib/server/data-sources/request";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  try {
    const result = await registerDatabaseDataSource(
      await readJsonRequest(request),
    );
    return Response.json(result, { status: 201 });
  } catch (error) {
    return dataSourceApiError(error);
  }
}
