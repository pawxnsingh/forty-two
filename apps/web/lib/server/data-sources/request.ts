import { DataSourceApiError } from "./file-service";

const MAX_JSON_BODY_BYTES = 32 * 1024;

export async function readJsonRequest(
  request: Request,
  options: { allowEmpty?: boolean } = {},
): Promise<unknown> {
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/.test(declaredLength) ||
      Number(declaredLength) > MAX_JSON_BODY_BYTES)
  ) {
    throw new DataSourceApiError(
      413,
      "REQUEST_TOO_LARGE",
      "Request body is too large.",
    );
  }

  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_JSON_BODY_BYTES) {
    throw new DataSourceApiError(
      413,
      "REQUEST_TOO_LARGE",
      "Request body is too large.",
    );
  }
  if (text.trim() === "") {
    return options.allowEmpty ? {} : undefined;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new DataSourceApiError(
      400,
      "INVALID_JSON",
      "Request body must be valid JSON.",
    );
  }
}
