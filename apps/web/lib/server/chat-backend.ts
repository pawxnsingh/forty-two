import {
  TrueForge,
  TrueForgeError,
  type TrueForgeApi,
} from "@truefoundry/trueforge-sdk";

const MAX_FILES = 4;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_FILE_BYTES = 20 * 1024 * 1024;
const MAX_MULTIPART_BODY_BYTES = MAX_TOTAL_FILE_BYTES + 1024 * 1024;
const MAX_MESSAGE_CHARS = 20_000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/;
const TERMINAL_TURN_STATES = new Set(["done", "error", "cancelled"]);

let client: TrueForge | undefined;

export class ApiInputError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ApiInputError";
    this.status = status;
  }
}

export function trueForgeClient(): TrueForge {
  if (client) return client;
  const baseUrl = requiredEnvironment("TRUEFORGE_INTERNAL_URL");
  client = new TrueForge({ baseUrl, timeoutInSeconds: 60, maxRetries: 2 });
  return client;
}

export function agentName(): string {
  return process.env.FORTY_TWO_AGENT_NAME?.trim() || "forty-two-data-agent";
}

export function validId(value: string, label: string): string {
  if (!ID_PATTERN.test(value)) {
    throw new ApiInputError(`Invalid ${label}.`);
  }
  return value;
}

export async function readTurnInput(
  request: Request,
): Promise<TrueForgeApi.UserMessage> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.startsWith("multipart/form-data")) {
    return readMultipartTurnInput(request);
  }
  if (contentType.startsWith("application/json")) {
    const body = await request.json().catch(() => {
      throw new ApiInputError("Request body must be valid JSON.");
    });
    if (!isRecord(body))
      throw new ApiInputError("Request body must be an object.");
    return { type: "user.message", content: validateMessage(body.message) };
  }
  throw new ApiInputError(
    "Content-Type must be application/json or multipart/form-data.",
    415,
  );
}

async function readMultipartTurnInput(
  request: Request,
): Promise<TrueForgeApi.UserMessage> {
  const bytes = await readRequestBodyWithinLimit(
    request,
    MAX_MULTIPART_BODY_BYTES,
  );
  const boundedRequest = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: bytes,
  });
  const form = await boundedRequest.formData().catch(() => {
    throw new ApiInputError("Multipart body could not be parsed.");
  });
  const message = validateMessage(form.get("message"));
  const files = [...form.getAll("files"), ...form.getAll("file")].filter(
    (entry): entry is File => entry instanceof File && entry.size > 0,
  );
  if (files.length === 0) {
    throw new ApiInputError("At least one CSV or XLSX file is required.");
  }
  if (files.length > MAX_FILES) {
    throw new ApiInputError(`A turn can include at most ${MAX_FILES} files.`);
  }
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  if (totalBytes > MAX_TOTAL_FILE_BYTES) {
    throw new ApiInputError("The combined upload exceeds 20 MiB.", 413);
  }

  const parts: TrueForgeApi.UserMessageContentItem[] = [
    { type: "text", text: message },
  ];
  for (const file of files) parts.push(await encodeFile(file));
  return { type: "user.message", content: parts };
}

export async function readRequestBodyWithinLimit(
  request: Request,
  maxBytes: number,
): Promise<ArrayBuffer> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new ApiInputError("Content-Length is invalid.");
    }
    if (length > maxBytes) {
      throw new ApiInputError("The multipart request is too large.", 413);
    }
  }
  if (!request.body) {
    throw new ApiInputError("Multipart body could not be parsed.");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      totalBytes += next.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ApiInputError("The multipart request is too large.", 413);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

async function encodeFile(file: File): Promise<TrueForgeApi.FileContent> {
  if (file.size > MAX_FILE_BYTES) {
    throw new ApiInputError(`${file.name || "File"} exceeds 10 MiB.`, 413);
  }
  const name = safeFilename(file.name);
  const extension = name.slice(name.lastIndexOf(".")).toLowerCase();
  const bytes = new Uint8Array(await file.arrayBuffer());
  let mime: string;
  if (extension === ".csv") {
    if (bytes.includes(0))
      throw new ApiInputError(`${name} is not a text CSV.`);
    mime = "text/csv";
  } else if (extension === ".xlsx") {
    if (
      bytes.length < 4 ||
      bytes[0] !== 0x50 ||
      bytes[1] !== 0x4b ||
      bytes[2] !== 0x03 ||
      bytes[3] !== 0x04
    ) {
      throw new ApiInputError(`${name} is not a valid XLSX container.`);
    }
    mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  } else {
    throw new ApiInputError(`${name} must use the .csv or .xlsx extension.`);
  }
  return {
    type: "file",
    name,
    data: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`,
  };
}

function validateMessage(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiInputError("message must be a non-empty string.");
  }
  const message = value.trim();
  if (message.length > MAX_MESSAGE_CHARS) {
    throw new ApiInputError("message exceeds 20,000 characters.", 413);
  }
  return message;
}

function safeFilename(value: string): string {
  const name = value.trim();
  if (
    !name ||
    name.length > 128 ||
    name.includes("/") ||
    name.includes("\\") ||
    [...name].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  ) {
    throw new ApiInputError("Uploaded filename is invalid.");
  }
  return name;
}

export async function listAllEvents(
  sessionId: string,
  lastTurnId?: string,
): Promise<TrueForgeApi.SessionEventItem[]> {
  const page = await trueForgeClient().sessions.listEvents(sessionId, {
    lastTurnId,
    limit: 100,
  });
  const events: TrueForgeApi.SessionEventItem[] = [];
  for await (const event of page) {
    events.push(event);
    if (events.length > 10_000) {
      throw new Error("TrueForge event history exceeded the safety limit.");
    }
  }
  return events;
}

export async function waitForTurn(
  sessionId: string,
  turnId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<TrueForgeApi.Turn> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    assertWaitActive(signal);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new ApiInputError("Turn is still running.", 408);

    const requestController = new AbortController();
    const abortFromCaller = () => requestController.abort(signal?.reason);
    signal?.addEventListener("abort", abortFromCaller, { once: true });
    const deadlineTimer = setTimeout(
      () => requestController.abort(),
      remaining,
    );
    let turn: TrueForgeApi.Turn;
    try {
      turn = (
        await trueForgeClient().sessions.getTurn(sessionId, turnId, {
          abortSignal: requestController.signal,
          maxRetries: 0,
          timeoutInSeconds: Math.max(0.001, remaining / 1_000),
        })
      ).data;
    } catch (error) {
      assertWaitActive(signal);
      if (requestController.signal.aborted || Date.now() >= deadline) {
        throw new ApiInputError("Turn is still running.", 408);
      }
      throw error;
    } finally {
      clearTimeout(deadlineTimer);
      signal?.removeEventListener("abort", abortFromCaller);
    }

    if (TERMINAL_TURN_STATES.has(turn.state.status)) return turn;
    const delayRemaining = deadline - Date.now();
    if (delayRemaining <= 0) {
      throw new ApiInputError("Turn is still running.", 408);
    }
    await abortableDelay(Math.min(750, delayRemaining), signal);
  }
}

export function parseWaitTimeout(body: unknown): number {
  if (body === undefined || body === null) return 300_000;
  if (!isRecord(body))
    throw new ApiInputError("Request body must be an object.");
  const seconds = body.timeoutSeconds ?? 300;
  if (
    !Number.isInteger(seconds) ||
    Number(seconds) < 1 ||
    Number(seconds) > 300
  ) {
    throw new ApiInputError("timeoutSeconds must be an integer from 1 to 300.");
  }
  return Number(seconds) * 1_000;
}

export async function deleteSessionResources(sessionId: string): Promise<void> {
  const sdk = trueForgeClient();
  const failures: Error[] = [];
  try {
    await sdk.sessions.cancel(sessionId);
  } catch (error) {
    if (!isSdkStatus(error, 404) && !isSdkStatus(error, 412))
      failures.push(asError(error));
  }

  const turns: TrueForgeApi.Turn[] = [];
  try {
    const page = await sdk.sessions.listTurns(sessionId, { limit: 25 });
    for await (const turn of page) turns.push(turn);
  } catch (error) {
    failures.push(asError(error));
  }

  let eventItems: TrueForgeApi.SessionEventItem[] = [];
  let eventDiscoveryComplete = turns.length === 0;
  if (turns.length > 0) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        eventItems = await listAllEvents(sessionId, turns[0]?.id);
        if (eventItems.some(({ event }) => event.type === "sandbox.created")) {
          eventDiscoveryComplete = true;
          break;
        }
      } catch (error) {
        if (attempt === 3) failures.push(asError(error));
      }
      if (attempt < 3) await delay(attempt * 250);
    }
  }

  const sandboxIds = new Set(
    eventItems.flatMap(({ event }) =>
      event.type === "sandbox.created" ? [rawDaytonaId(event.sandboxId)] : [],
    ),
  );
  for (const sandboxId of sandboxIds) {
    try {
      await deleteDaytonaSandbox(sandboxId);
    } catch (error) {
      failures.push(asError(error));
    }
  }

  if (eventDiscoveryComplete && failures.length === 0) {
    await sdk.sessions.delete(sessionId);
  } else if (!eventDiscoveryComplete) {
    failures.push(
      new Error(
        `Retained TrueForge session ${sessionId} because sandbox disposition is unknown.`,
      ),
    );
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Session cleanup was incomplete.");
  }
}

async function deleteDaytonaSandbox(sandboxId: string): Promise<void> {
  const baseUrl = normalizeHttpUrl(
    process.env.DAYTONA_API_URL ?? "https://app.daytona.io/api",
  );
  const response = await fetch(
    `${baseUrl}/sandbox/${encodeURIComponent(sandboxId)}`,
    {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${requiredEnvironment("DAYTONA_API_KEY")}`,
      },
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(`Daytona sandbox deletion failed (${response.status}).`);
  }
}

function rawDaytonaId(value: string): string {
  const prefix = "v1:daytona:";
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

export function apiError(error: unknown): Response {
  if (error instanceof ApiInputError) {
    return Response.json(
      { error: { message: error.message } },
      { status: error.status },
    );
  }
  if (error instanceof TrueForgeError) {
    const status =
      error.statusCode && error.statusCode >= 400 && error.statusCode < 600
        ? error.statusCode
        : 502;
    return Response.json(
      { error: { message: sdkErrorMessage(error.body) } },
      { status },
    );
  }
  console.error("Chat backend request failed", error);
  return Response.json(
    { error: { message: "The chat backend could not complete the request." } },
    { status: 502 },
  );
}

function sdkErrorMessage(body: unknown): string {
  if (
    isRecord(body) &&
    isRecord(body.error) &&
    typeof body.error.message === "string"
  ) {
    return body.error.message;
  }
  return "TrueForge could not complete the request.";
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function normalizeHttpUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Service URL must use HTTP or HTTPS.");
  }
  return url.toString().replace(/\/$/, "");
}

function isSdkStatus(error: unknown, status: number): boolean {
  return error instanceof TrueForgeError && error.statusCode === status;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assertWaitActive(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ApiInputError("Wait request was cancelled.", 499);
  }
}

function abortableDelay(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  assertWaitActive(signal);
  if (!signal) return delay(milliseconds);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new ApiInputError("Wait request was cancelled.", 499));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}
