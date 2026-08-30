import {
  TrueForge,
  TrueForgeError,
  type TrueForgeApi,
} from "@truefoundry/trueforge-sdk";
import {
  activateChatSession,
  beginChatSessionQuestion,
  ChatTurnRequestConflictError,
  ChatTurnRequestUnavailableError,
  ChatSessionDataSourceLimitError,
  ChatSessionDataSourceUnavailableError,
  ChatSessionIdempotencyConflictError,
  completeChatTurnRequest,
  createChatSession,
  failChatSession,
  getChatSession,
  getChatSessionForCleanup,
  getChatTurnRequest,
  listChatSessionDataSources,
  markChatTurnRequestIndeterminate,
  mintArtifactBrowserCapability,
  recordSqlChangeApproval,
  reserveChatTurnRequest,
  rotateChatSessionCapability,
  softDeleteChatSession,
  SqlChangeConflictError,
  SqlChangeReplayError,
  type ChatSession,
  type ChatTurnRequest,
  type DataSourceId,
  verifyArtifactBrowserCapability,
} from "@forty-two/db";
import { createHash, randomUUID } from "node:crypto";
import { ZodError } from "zod";

const MAX_MESSAGE_CHARS = 20_000;
const MAX_JSON_BODY_BYTES = 64 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/;
const TERMINAL_TURN_STATES = new Set(["done", "error", "cancelled"]);
export const SHARED_DATA_SOURCE_MCP_NAME = "forty-two-data-source";
type TextUserMessage = TrueForgeApi.UserMessage & { content: string };

let client: TrueForge | undefined;
const approvalContinuations = new Map<
  string,
  {
    identity: string;
    promise: Promise<TrueForgeApi.GetTurnResponse>;
    expiresAt: number;
  }
>();
const APPROVAL_CONTINUATION_TTL_MS = 10 * 60_000;
const MAX_APPROVAL_CONTINUATIONS = 1_000;
const TURN_REQUEST_WAIT_ATTEMPTS = 100;
const TURN_REQUEST_WAIT_INTERVAL_MS = 50;

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

export async function createApplicationSession(request: Request): Promise<{
  id: string;
  status: "active";
  artifactCapability: string;
}> {
  const body = await requiredJsonBody(request);
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "dataSourceIds") {
    throw new ApiInputError("Request body must contain only dataSourceIds.");
  }
  if (!Array.isArray(body.dataSourceIds) || body.dataSourceIds.length === 0) {
    throw new ApiInputError("dataSourceIds must contain at least one id.");
  }
  const dataSourceIds = body.dataSourceIds.map((value) =>
    validDataSourceId(value),
  );
  const idempotencyKey = optionalIdempotencyKey(request);
  const capabilityExpiresAt = new Date(
    Date.now() + capabilityTtlSeconds() * 1_000,
  );
  const result = await createChatSession({
    dataSourceIds,
    maxDataSources: maximumSessionDataSources(),
    capabilityId: randomUUID(),
    capabilityExpiresAt,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });

  if (!result.created) {
    const settled = settledExistingApplicationSession(result.chatSession);
    if (settled) return applicationSessionResponse(settled);
    const ready = await waitForApplicationSession(result.chatSession.id);
    return applicationSessionResponse(ready);
  }

  let trueforgeSessionId: string | undefined;
  try {
    const manifest = await productAgentManifest(result.chatSession.id);
    const session = await trueForgeClient().sessions.create({
      agent: { spec: manifest },
    });
    trueforgeSessionId = session.data.id;
    const active = await activateChatSession({
      chatSessionId: result.chatSession.id,
      trueforgeSessionId,
    });
    if (!active)
      throw new Error("Application session activation lost its state.");
    return applicationSessionResponse(active);
  } catch (error) {
    await failChatSession({
      chatSessionId: result.chatSession.id,
      failureMessage: "TrueForge session creation failed.",
    }).catch(() => undefined);
    if (trueforgeSessionId) {
      await trueForgeClient()
        .sessions.delete(trueforgeSessionId)
        .catch(() => undefined);
    }
    throw error;
  }
}

export function settledExistingApplicationSession(
  session: ChatSession,
): ChatSession | undefined {
  if (session.status === "active") return session;
  if (session.status === "failed") {
    throw new Error("Idempotent chat session creation previously failed.");
  }
  if (session.status === "deleted" || session.deletedAt) {
    throw new ApiInputError(
      "Idempotency-Key belongs to a deleted chat session.",
      409,
    );
  }
  return undefined;
}

export async function applicationSession(
  applicationSessionId: string,
): Promise<ChatSession> {
  const session = await getChatSession({ chatSessionId: applicationSessionId });
  if (!session || session.status !== "active" || !session.trueforgeSessionId) {
    throw new ApiInputError("Chat session was not found.", 404);
  }
  return session;
}

export async function renewArtifactCapability(
  request: Request,
  applicationSessionId: string,
): Promise<{ artifactCapability: string }> {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([^\s,]+)$/i.exec(authorization);
  if (!match) throw new ApiInputError("Artifact capability was not found.", 404);

  const claims = verifyArtifactBrowserCapability({
    token: match[1]!,
    signingKey: requiredEnvironment("MCP_CAPABILITY_SIGNING_KEY"),
    allowExpiredForSeconds: 7 * 24 * 60 * 60,
  });
  if (!claims || claims.sub !== applicationSessionId) {
    throw new ApiInputError("Artifact capability was not found.", 404);
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + capabilityTtlSeconds() * 1_000);
  const renewed = await rotateChatSessionCapability({
    chatSessionId: applicationSessionId,
    capabilityId: claims.jti,
    capabilityExpiresAt: expiresAt,
  });
  if (!renewed) {
    throw new ApiInputError("Artifact capability was not found.", 404);
  }
  return {
    artifactCapability: mintArtifactBrowserCapability({
      chatSessionId: renewed.id,
      capabilityId: renewed.capabilityId,
      expiresAt: renewed.capabilityExpiresAt,
      issuedAt: now,
      signingKey: requiredEnvironment("MCP_CAPABILITY_SIGNING_KEY"),
    }),
  };
}

export async function trueforgeSessionId(
  applicationSessionId: string,
): Promise<string> {
  return (await applicationSession(applicationSessionId)).trueforgeSessionId!;
}

export interface ApplicationTurnDependencies {
  reserve(input: {
    chatSessionId: string;
    idempotencyKey: string;
    requestHash: string;
  }): Promise<{ request: ChatTurnRequest; reserved: boolean }>;
  get(input: {
    chatSessionId: string;
    idempotencyKey: string;
  }): Promise<ChatTurnRequest | null>;
  complete(input: {
    chatSessionId: string;
    idempotencyKey: string;
    requestHash: string;
    trueforgeTurnId: string;
  }): Promise<ChatTurnRequest>;
  markIndeterminate(input: {
    chatSessionId: string;
    idempotencyKey: string;
    requestHash: string;
  }): Promise<ChatTurnRequest>;
  beginQuestion(input: {
    chatSessionId: string;
    questionKey: string;
  }): Promise<unknown>;
  trueforgeSessionId(applicationSessionId: string): Promise<string>;
  createTurn(
    trueforgeSessionId: string,
    userMessage: TextUserMessage,
  ): Promise<TrueForgeApi.GetTurnResponse>;
  getTurn(
    trueforgeSessionId: string,
    trueforgeTurnId: string,
  ): Promise<TrueForgeApi.GetTurnResponse>;
  wait(milliseconds: number): Promise<void>;
}

export interface TurnCreationClient {
  createTurn(
    sessionId: string,
    request: { input: TextUserMessage[] },
    options: { maxRetries: number },
  ): Promise<TrueForgeApi.GetTurnResponse>;
}

export function createTrueForgeTurnOnce(
  sessions: TurnCreationClient,
  sessionId: string,
  userMessage: TextUserMessage,
): Promise<TrueForgeApi.GetTurnResponse> {
  return sessions.createTurn(
    sessionId,
    { input: [userMessage] },
    { maxRetries: 0 },
  );
}

const defaultApplicationTurnDependencies: ApplicationTurnDependencies = {
  reserve: reserveChatTurnRequest,
  get: getChatTurnRequest,
  complete: completeChatTurnRequest,
  markIndeterminate: markChatTurnRequestIndeterminate,
  beginQuestion: beginChatSessionQuestion,
  trueforgeSessionId,
  createTurn: (sessionId, userMessage) =>
    createTrueForgeTurnOnce(trueForgeClient().sessions, sessionId, userMessage),
  getTurn: (sessionId, turnId) =>
    trueForgeClient().sessions.getTurn(sessionId, turnId),
  wait: delay,
};

export async function createApplicationTurn(
  applicationSessionId: string,
  userMessage: TextUserMessage,
  request: Request,
  dependencies: ApplicationTurnDependencies = defaultApplicationTurnDependencies,
): Promise<TrueForgeApi.GetTurnResponse> {
  const idempotencyKey = optionalIdempotencyKey(request);
  if (!idempotencyKey) {
    await dependencies.beginQuestion({
      chatSessionId: applicationSessionId,
      questionKey: randomUUID(),
    });
    return dependencies.createTurn(
      await dependencies.trueforgeSessionId(applicationSessionId),
      userMessage,
    );
  }

  const requestHash = createHash("sha256")
    .update(userMessage.content, "utf8")
    .digest("hex");
  const identity = {
    chatSessionId: applicationSessionId,
    idempotencyKey,
    requestHash,
  };
  const reservation = await dependencies.reserve(identity);

  if (!reservation.reserved) {
    const settled = await waitForTurnRequest(
      reservation.request,
      identity,
      dependencies,
    );
    const trueforgeSession =
      await dependencies.trueforgeSessionId(applicationSessionId);
    return dependencies.getTurn(trueforgeSession, settled.trueforgeTurnId!);
  }

  try {
    const trueforgeSession =
      await dependencies.trueforgeSessionId(applicationSessionId);
    await dependencies.beginQuestion({
      chatSessionId: applicationSessionId,
      questionKey: idempotencyKey,
    });
    const turn = await dependencies.createTurn(trueforgeSession, userMessage);
    const trueforgeTurnId = validId(turn.data.id, "turn id");
    await dependencies.complete({ ...identity, trueforgeTurnId });
    return turn;
  } catch (error) {
    await dependencies.markIndeterminate(identity).catch(() => undefined);
    throw error;
  }
}

async function waitForTurnRequest(
  initial: ChatTurnRequest,
  identity: {
    chatSessionId: string;
    idempotencyKey: string;
    requestHash: string;
  },
  dependencies: ApplicationTurnDependencies,
): Promise<ChatTurnRequest> {
  let current: ChatTurnRequest | null = initial;
  for (let attempt = 0; attempt <= TURN_REQUEST_WAIT_ATTEMPTS; attempt += 1) {
    if (current?.requestHash !== identity.requestHash) {
      throw new ChatTurnRequestConflictError();
    }
    if (current.state === "created" && current.trueforgeTurnId) return current;
    if (current.state === "indeterminate") {
      throw new ApiInputError(
        "The prior turn request has an indeterminate outcome and will not be retried automatically.",
        409,
      );
    }
    if (attempt === TURN_REQUEST_WAIT_ATTEMPTS) break;
    await dependencies.wait(TURN_REQUEST_WAIT_INTERVAL_MS);
    current = await dependencies.get(identity);
  }
  throw new ApiInputError(
    "The matching turn request is still being created; retry later with the same Idempotency-Key.",
    503,
  );
}

export async function deleteApplicationSession(
  applicationSessionId: string,
  dependencies: ApplicationSessionCleanupDependencies = defaultApplicationSessionCleanupDependencies,
): Promise<void> {
  let session = await dependencies.getSession(applicationSessionId);
  if (!session || !session.trueforgeSessionId) {
    throw new ApiInputError("Chat session was not found.", 404);
  }
  if (session.status === "active") {
    session =
      (await dependencies.revokeSession(applicationSessionId)) ??
      (await dependencies.getSession(applicationSessionId));
  }
  if (
    !session ||
    session.status !== "deleted" ||
    !session.capabilityRevokedAt
  ) {
    throw new Error("Application session revocation did not complete.");
  }
  const cleanup = await Promise.allSettled([
    dependencies.deleteSessionResources(session.trueforgeSessionId!),
  ]);
  const failures = cleanup.flatMap((result) =>
    result.status === "rejected" ? [asError(result.reason)] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "Application session was revoked but external cleanup was incomplete.",
    );
  }
}

export interface ApplicationSessionCleanupDependencies {
  getSession(applicationSessionId: string): Promise<ChatSession | null>;
  revokeSession(applicationSessionId: string): Promise<ChatSession | null>;
  deleteSessionResources(trueforgeSessionId: string): Promise<void>;
}

export interface TrueForgeSessionCleanupDependencies {
  cancelSession(trueforgeSessionId: string): Promise<unknown>;
  listTurns(trueforgeSessionId: string): Promise<ReadonlyArray<{ id: string }>>;
  listEvents(
    trueforgeSessionId: string,
    lastTurnId?: string,
  ): Promise<TrueForgeApi.SessionEventItem[]>;
  deleteDaytonaSandbox(sandboxId: string): Promise<void>;
  deleteTrueForgeSession(trueforgeSessionId: string): Promise<unknown>;
  wait(milliseconds: number): Promise<void>;
}

const defaultApplicationSessionCleanupDependencies: ApplicationSessionCleanupDependencies =
  {
    getSession: (applicationSessionId) =>
      getChatSessionForCleanup({ chatSessionId: applicationSessionId }),
    revokeSession: (applicationSessionId) =>
      softDeleteChatSession({ chatSessionId: applicationSessionId }),
    deleteSessionResources,
  };

export function validId(value: string, label: string): string {
  if (!ID_PATTERN.test(value)) {
    throw new ApiInputError(`Invalid ${label}.`);
  }
  return value;
}

export async function readTurnInput(
  request: Request,
): Promise<TextUserMessage> {
  const body = await requiredJsonBody(request);
  return { type: "user.message", content: validateMessage(body.message) };
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

async function productAgentManifest(
  applicationSessionId: string,
): Promise<TrueForgeApi.AgentSpec> {
  const response = await trueForgeClient().agents.list();
  const agent = response.data.find(
    (candidate) => candidate.name === agentName(),
  );
  if (!agent) throw new Error(`Configured agent ${agentName()} was not found.`);
  const sources = await listChatSessionDataSources({
    chatSessionId: applicationSessionId,
  });
  const sourceContext = sources
    .map((source) =>
      source.connectorType === "csv" || source.connectorType === "xlsx"
        ? `- file: ${source.id} (${source.originalFilename}, ${source.mimeType}, ${source.fileSizeBytes} bytes)`
        : `- database: ${source.id} (${source.name}, ${source.connectorType})`,
    )
    .join("\n");
  const artifactPresentationContext = `<artifact_presentation>\nA table created only to supply data to a chart is an internal dependency. When the user requests a chart, reference only the committed chart artifact in the final answer. Do not reference, describe, or present its source table unless the user explicitly asks to see or download that table.\n</artifact_presentation>`;
  const sessionContext = `<session_context>\nThe public Forty Two application session ID is ${applicationSessionId}. Pass this exact non-secret sessionId unchanged to every ${SHARED_DATA_SOURCE_MCP_NAME} datasource, file, database, SQL, table-artifact, and chart-artifact tool, to emit_table/load_table/visualize in Daytona, and to the forty-two-todo plan tool. Never substitute the TrueForge runtime ID.\nOnly these immutable datasource bindings are available:\n${sourceContext}\nFor every datasource-specific tool, also pass the exact bound dataSourceId shown above. For every file, call get_file_download_url on ${SHARED_DATA_SOURCE_MCP_NAME} from Daytona Code Mode, download Azure directly with the returned If-Match header, and verify both ETag and byte size before reading it. File bytes must never enter a TrueForge message or transit the Forty Two web server. run_read_query is side-effect-free.\n${artifactWorkflowInstructions()}\n</session_context>`;
  const productServers = (agent.manifest.mcpServers ?? []).filter((server) =>
    [SHARED_DATA_SOURCE_MCP_NAME, "forty-two-todo"].includes(server.name),
  );
  if (
    productServers.filter(
      (server) => server.name === SHARED_DATA_SOURCE_MCP_NAME,
    ).length !== 1
  ) {
    throw new Error(
      `Configured agent ${agentName()} must contain exactly one ${SHARED_DATA_SOURCE_MCP_NAME} MCP server.`,
    );
  }
  return {
    ...agent.manifest,
    instructions: `${agent.manifest.instructions ?? ""}\n\n${artifactPresentationContext}\n\n${sessionContext}`,
    mcpServers: productServers,
  };
}

export function artifactWorkflowInstructions(): string {
  return `Use exactly one of these table-artifact paths; never mix them:
1. Database-query path: create_query_table_artifact performs the query, writes the artifact, commits its metadata, and returns a bounded receipt. Its artifact.artifactId is already the final committed table id. NEVER call finalize_table_artifact for an artifact returned by create_query_table_artifact. Use that committed id directly with Python visualize.
2. Daytona-generated path: for file-derived, transformed, or combined rows, import emit_table, load_table, and visualize from the snapshot-installed forty_two_artifacts module. Complete rows move Daytona-to-Azure through emit_table; only its bounded receipt may reach the model. Call finalize_table_artifact exactly once for that emit_table receipt. The returned artifact id is the committed table id to pass to Python visualize.
For either path, pass the bounded visualize receipt unchanged to finalize_chart_artifact. Never call an MCP tool named visualize. For each genuinely new create_query_table_artifact operation, generate a new UUID requestId. Retry the same requestId only when the result is ambiguous; an explicit error is not ambiguous and must not be retried blindly with a new identity.`;
}

async function requiredJsonBody(
  request: Request,
): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new ApiInputError("Content-Type must be application/json.", 415);
  }
  const text = await boundedRequestText(request, MAX_JSON_BODY_BYTES);
  if (!text) throw new ApiInputError("Request body must be valid JSON.");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ApiInputError("Request body must be valid JSON.");
  }
  if (!isRecord(value))
    throw new ApiInputError("Request body must be an object.");
  return value;
}

async function boundedRequestText(
  request: Request,
  maximumBytes: number,
): Promise<string> {
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maximumBytes)
  ) {
    throw new ApiInputError("Request body is too large.", 413);
  }
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      totalBytes += next.value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ApiInputError("Request body is too large.", 413);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.concat(chunks, totalBytes),
  );
}

function optionalIdempotencyKey(request: Request): string | undefined {
  const value = request.headers.get("idempotency-key")?.trim();
  if (!value) return undefined;
  if (value.length > 255) {
    throw new ApiInputError("Idempotency-Key exceeds 255 characters.");
  }
  return value;
}

function validDataSourceId(value: unknown): DataSourceId {
  if (typeof value !== "string" || !/^ds_[0-9A-HJKMNP-TV-Z]{26}$/.test(value)) {
    throw new ApiInputError("dataSourceIds contains an invalid id.");
  }
  return value as DataSourceId;
}

async function waitForApplicationSession(id: string): Promise<ChatSession> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const session = await getChatSession({ chatSessionId: id });
    if (session?.status === "active") return session;
    if (session) settledExistingApplicationSession(session);
    await delay(100);
  }
  throw new Error("Timed out waiting for idempotent chat session creation.");
}

function applicationSessionResponse(session: ChatSession): {
  id: string;
  status: "active";
  artifactCapability: string;
} {
  if (session.status !== "active" || !session.trueforgeSessionId) {
    throw new Error("Application session is not active.");
  }
  return {
    id: session.id,
    status: "active",
    artifactCapability: mintArtifactBrowserCapability({
      chatSessionId: session.id,
      capabilityId: session.capabilityId,
      expiresAt: session.capabilityExpiresAt,
      issuedAt: session.createdAt,
      signingKey: requiredEnvironment("MCP_CAPABILITY_SIGNING_KEY"),
    }),
  };
}

function maximumSessionDataSources(): number {
  return boundedIntegerEnvironment("CHAT_SESSION_MAX_DATA_SOURCES", 8, 1, 100);
}

function capabilityTtlSeconds(): number {
  return boundedIntegerEnvironment(
    "MCP_CAPABILITY_TTL_SECONDS",
    86_400,
    300,
    86_400,
  );
}

function boundedIntegerEnvironment(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  return value;
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

export async function resolveSqlChangeApproval(
  applicationSessionId: string,
  trueforgeTurnId: string,
  request: Request,
): Promise<TrueForgeApi.GetTurnResponse> {
  const body = await requiredJsonBody(request);
  const allowedKeys = new Set(["toolCallId", "decision", "reason"]);
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
    throw new ApiInputError("Approval request contains an unknown field.");
  }
  const toolCallId = validId(String(body.toolCallId ?? ""), "tool call id");
  const decision = body.decision;
  if (decision !== "allow" && decision !== "deny") {
    throw new ApiInputError("decision must be allow or deny.");
  }
  const reason = body.reason;
  if (
    reason !== undefined &&
    (typeof reason !== "string" || !reason.trim() || reason.length > 1_000)
  ) {
    throw new ApiInputError(
      "reason must be a non-empty string up to 1000 characters.",
    );
  }
  if (decision === "allow" && reason !== undefined) {
    throw new ApiInputError("reason is supported only for denial.");
  }

  const session = await applicationSession(applicationSessionId);
  const runtimeSessionId = session.trueforgeSessionId!;
  const eventItems = (
    await listAllEvents(runtimeSessionId, trueforgeTurnId)
  ).filter((item) => item.turnId === trueforgeTurnId);
  const approvalEvent = eventItems
    .map((item) => item.event)
    .find(
      (event): event is TrueForgeApi.ToolApprovalRequiredEvent =>
        event.type === "tool.approval_required" &&
        event.toolCalls.some((call) => call.id === toolCallId),
    );
  if (!approvalEvent) {
    throw new ApiInputError("Pending SQL change approval was not found.", 409);
  }
  const callRef = approvalEvent.toolCalls.find(
    (call) => call.id === toolCallId,
  )!;
  const sourceEvent = eventItems
    .map((item) => item.event)
    .find(
      (event): event is TrueForgeApi.ModelMessageEvent =>
        event.type === "model.message" && event.id === callRef.sourceEventId,
    );
  const toolCall = sourceEvent?.toolCalls?.find(
    (call) => call.id === toolCallId,
  );
  if (!toolCall) {
    throw new ApiInputError(
      "Approval target is not the scoped SQL apply tool.",
      409,
    );
  }
  const argumentsValue = sqlApplyApprovalArguments(
    toolCall,
    SHARED_DATA_SOURCE_MCP_NAME,
  );
  if (argumentsValue.sessionId !== session.id) {
    throw new ApiInputError(
      "SQL change approval belongs to a different application session.",
      409,
    );
  }
  if (
    eventItems.some(
      ({ event }) =>
        event.type === "tool.response" && event.toolCallId === toolCallId,
    )
  ) {
    throw new ApiInputError("SQL change approval was already resolved.", 409);
  }
  if (
    typeof argumentsValue.changeSetId !== "string" ||
    !/^change_[0-9A-HJKMNP-TV-Z]{26}$/.test(argumentsValue.changeSetId)
  ) {
    throw new ApiInputError(
      "SQL change approval is missing its change set.",
      409,
    );
  }

  return runApprovalContinuationOnce(
    `${runtimeSessionId}:${trueforgeTurnId}:${toolCallId}`,
    `${decision}:${reason?.trim() ?? ""}`,
    () =>
      recordApprovalThenContinue(
        () =>
          recordSqlChangeApproval({
            changeSetId: argumentsValue.changeSetId as string,
            chatSessionId: session.id,
            trueforgeTurnId,
            trueforgeToolCallId: toolCallId,
            decision,
          }).then(() => undefined),
        () =>
          trueForgeClient().sessions.createTurn(runtimeSessionId, {
            previousTurnId: trueforgeTurnId,
            input: [
              {
                type: "user.tool_approval",
                threadId: approvalEvent.threadId,
                toolCallId,
                approval:
                  decision === "allow"
                    ? { status: "allow" }
                    : {
                        status: "deny",
                        ...(reason ? { reason: reason.trim() } : {}),
                      },
              },
            ],
          }),
      ),
  );
}

export async function recordApprovalThenContinue<T>(
  record: () => Promise<void>,
  continueTurn: () => Promise<T>,
): Promise<T> {
  await record();
  return continueTurn();
}

export function runApprovalContinuationOnce(
  key: string,
  identity: string,
  create: () => Promise<TrueForgeApi.GetTurnResponse>,
): Promise<TrueForgeApi.GetTurnResponse> {
  const now = Date.now();
  for (const [storedKey, stored] of approvalContinuations) {
    if (stored.expiresAt <= now) approvalContinuations.delete(storedKey);
  }
  const existing = approvalContinuations.get(key);
  if (existing) {
    if (existing.identity !== identity) {
      throw new ApiInputError(
        "SQL change approval is already resolving with another decision.",
        409,
      );
    }
    return existing.promise;
  }
  const promise = Promise.resolve().then(create);
  approvalContinuations.set(key, {
    identity,
    promise,
    expiresAt: now + APPROVAL_CONTINUATION_TTL_MS,
  });
  void promise.catch(() => {
    if (approvalContinuations.get(key)?.promise === promise) {
      approvalContinuations.delete(key);
    }
  });
  while (approvalContinuations.size > MAX_APPROVAL_CONTINUATIONS) {
    const oldest = approvalContinuations.keys().next().value;
    if (typeof oldest !== "string") break;
    approvalContinuations.delete(oldest);
  }
  return promise;
}

export function sqlApplyApprovalArguments(
  toolCall: unknown,
  expectedMcpServerName: string,
): Record<string, unknown> {
  if (!isRecord(toolCall) || !isRecord(toolCall.toolInfo)) {
    throw new ApiInputError(
      "Approval target is not the scoped SQL apply tool.",
      409,
    );
  }
  const toolInfo = toolCall.toolInfo;
  if (
    !isRecord(toolCall.function) ||
    typeof toolCall.function.arguments !== "string"
  ) {
    throw new ApiInputError("SQL change approval arguments are invalid.", 409);
  }
  const outerArguments = parseApprovalArguments(toolCall.function.arguments);
  if (
    toolInfo.type === "mcp" &&
    toolInfo.serverName === expectedMcpServerName &&
    toolInfo.name === "apply_sql_change" &&
    Object.keys(toolInfo).every((key) =>
      ["type", "serverName", "name"].includes(key),
    )
  ) {
    return exactSqlApplyArguments(outerArguments);
  }
  if (
    toolInfo.type !== "truefoundry-system" ||
    toolInfo.name !== "call_tool" ||
    !Object.keys(toolInfo).every((key) => ["type", "name"].includes(key)) ||
    Object.keys(outerArguments).some(
      (key) => !["mcp_server", "tool_name", "input"].includes(key),
    ) ||
    outerArguments.mcp_server !== expectedMcpServerName ||
    outerArguments.tool_name !== "apply_sql_change" ||
    !isRecord(outerArguments.input)
  ) {
    throw new ApiInputError(
      "Approval target is not the scoped SQL apply tool.",
      409,
    );
  }
  return exactSqlApplyArguments(outerArguments.input);
}

const SQL_APPLY_ARGUMENT_KEYS = [
  "changeSetId",
  "sessionId",
  "dataSourceId",
  "connector",
  "operation",
  "target",
  "canonicalSql",
  "statementHash",
  "expectedAffectedRows",
  "resourceEstimate",
] as const;

function exactSqlApplyArguments(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const target = value.target;
  const validTarget =
    isRecord(target) &&
    Object.keys(target).length === 3 &&
    Object.keys(target).every((key) =>
      ["catalog", "schema", "table"].includes(key),
    ) &&
    (target.catalog === null || typeof target.catalog === "string") &&
    (target.schema === null || typeof target.schema === "string") &&
    typeof target.table === "string" &&
    target.table.length > 0;
  if (
    Object.keys(value).length !== SQL_APPLY_ARGUMENT_KEYS.length ||
    Object.keys(value).some(
      (key) => !(SQL_APPLY_ARGUMENT_KEYS as readonly string[]).includes(key),
    )
  ) {
    throw new ApiInputError("SQL change approval arguments are invalid.", 409);
  }
  if (
    typeof value.changeSetId !== "string" ||
    !/^change_[0-9A-HJKMNP-TV-Z]{26}$/.test(value.changeSetId) ||
    typeof value.sessionId !== "string" ||
    !/^sess_[0-9A-HJKMNP-TV-Z]{26}$/.test(value.sessionId) ||
    typeof value.dataSourceId !== "string" ||
    !/^ds_[0-9A-HJKMNP-TV-Z]{26}$/.test(value.dataSourceId) ||
    ![
      "postgresql",
      "mysql",
      "sqlserver",
      "snowflake",
      "bigquery",
      "redshift",
    ].includes(String(value.connector)) ||
    ![
      "insert",
      "update",
      "delete",
      "add_column",
      "rename_column",
      "add_and_backfill_column",
    ].includes(String(value.operation)) ||
    !validTarget ||
    typeof value.canonicalSql !== "string" ||
    value.canonicalSql.length === 0 ||
    typeof value.statementHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.statementHash) ||
    !Number.isInteger(value.expectedAffectedRows) ||
    Number(value.expectedAffectedRows) < 0 ||
    Number(value.expectedAffectedRows) > 100 ||
    (value.resourceEstimate !== null && !isRecord(value.resourceEstimate))
  ) {
    throw new ApiInputError("SQL change approval arguments are invalid.", 409);
  }
  return value;
}

function parseApprovalArguments(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ApiInputError("SQL change approval arguments are invalid.", 409);
  }
  if (!isRecord(parsed)) {
    throw new ApiInputError("SQL change approval arguments are invalid.", 409);
  }
  return parsed;
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

export async function deleteSessionResources(
  sessionId: string,
  dependencies: TrueForgeSessionCleanupDependencies = defaultTrueForgeSessionCleanupDependencies,
): Promise<void> {
  const failures: Error[] = [];
  try {
    await dependencies.cancelSession(sessionId);
  } catch (error) {
    if (isSdkStatus(error, 404)) {
      failures.push(
        new Error(
          `TrueForge session ${sessionId} is missing; sandbox disposition is unknown.`,
        ),
      );
    } else if (!isSdkStatus(error, 412)) failures.push(asError(error));
  }

  let turns: ReadonlyArray<{ id: string }> = [];
  try {
    turns = await dependencies.listTurns(sessionId);
  } catch (error) {
    if (
      !isSdkStatus(error, 404) ||
      !failures.some((failure) =>
        failure.message.includes("sandbox disposition is unknown"),
      )
    ) {
      failures.push(asError(error));
    }
  }

  let eventItems: TrueForgeApi.SessionEventItem[] = [];
  let eventDiscoveryComplete = turns.length === 0;
  if (turns.length > 0) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        eventItems = await dependencies.listEvents(sessionId, turns[0]?.id);
        eventDiscoveryComplete = true;
        break;
      } catch (error) {
        if (attempt === 3) failures.push(asError(error));
      }
      if (attempt < 3) await dependencies.wait(attempt * 250);
    }
  }

  const sandboxIds = new Set(
    eventItems.flatMap(({ event }) =>
      event.type === "sandbox.created" ? [rawDaytonaId(event.sandboxId)] : [],
    ),
  );
  for (const sandboxId of sandboxIds) {
    try {
      await dependencies.deleteDaytonaSandbox(sandboxId);
    } catch (error) {
      failures.push(asError(error));
    }
  }

  if (eventDiscoveryComplete && failures.length === 0) {
    await dependencies.deleteTrueForgeSession(sessionId);
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

const defaultTrueForgeSessionCleanupDependencies: TrueForgeSessionCleanupDependencies =
  {
    cancelSession: (sessionId) => trueForgeClient().sessions.cancel(sessionId),
    listTurns: async (sessionId) => {
      const page = await trueForgeClient().sessions.listTurns(sessionId, {
        limit: 25,
      });
      const turns: Array<{ id: string }> = [];
      for await (const turn of page) turns.push({ id: turn.id });
      return turns;
    },
    listEvents: listAllEvents,
    deleteDaytonaSandbox,
    deleteTrueForgeSession: (sessionId) =>
      trueForgeClient().sessions.delete(sessionId),
    wait: delay,
  };

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
  if (error instanceof ChatSessionIdempotencyConflictError) {
    return Response.json(
      { error: { message: error.message } },
      { status: 409 },
    );
  }
  if (error instanceof ChatTurnRequestConflictError) {
    return Response.json(
      { error: { message: error.message } },
      { status: 409 },
    );
  }
  if (error instanceof ChatTurnRequestUnavailableError) {
    return Response.json(
      { error: { message: error.message } },
      { status: 404 },
    );
  }
  if (
    error instanceof SqlChangeConflictError ||
    error instanceof SqlChangeReplayError
  ) {
    return Response.json(
      { error: { message: error.message } },
      { status: 409 },
    );
  }
  if (
    error instanceof ChatSessionDataSourceLimitError ||
    error instanceof ChatSessionDataSourceUnavailableError
  ) {
    return Response.json(
      { error: { message: error.message } },
      { status: 422 },
    );
  }
  if (error instanceof ZodError) {
    return Response.json(
      { error: { message: "Request validation failed." } },
      { status: 400 },
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
