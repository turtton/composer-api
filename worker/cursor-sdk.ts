import { sha256Hex } from "./crypto";
import { exchangeCursorApiKey } from "./cursor";
import { HttpError } from "./http";
import type { CursorCollectedOutput, CursorTextEvent } from "./cursor";
import type { CursorImage, CursorToolCall, Deps, Env } from "./types";

interface CursorSdkSession {
  agentId: string;
  updatedAt: number;
}

interface CursorSdkCompletion {
  agentId: string;
  runId: string;
  stream: AsyncGenerator<CursorTextEvent>;
}

interface ProtobufField {
  no: number;
  wt: number;
  value: number | Uint8Array;
}

type InteractionQueryKind = "websearch" | "webfetch";

type LocalSdkDecodedEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; id: string; toolCall: CursorToolCall; completed: boolean }
  | { type: "request_context"; id: number; execId?: string }
  | { type: "interaction_query"; id: number; kind: InteractionQueryKind; fieldNo: number }
  | { type: "subagent_output"; toolCallId: string; text: string }
  | { type: "done" }
  | { type: "ignore" };

const INTERACTION_QUERY_FIELD_BY_KIND: Record<InteractionQueryKind, number> = {
  websearch: 2,
  webfetch: 9
};

type ArgsKind =
  | "askQuestion"
  | "await"
  | "createPlan"
  | "delete"
  | "fetch"
  | "generateImage"
  | "glob"
  | "grep"
  | "listMcpResources"
  | "ls"
  | "mcp"
  | "readExec"
  | "readLints"
  | "readMcpResource"
  | "readTodos"
  | "readTool"
  | "semSearch"
  | "shell"
  | "switchMode"
  | "task"
  | "unsupported"
  | "updateTodos"
  | "webFetch"
  | "webSearch"
  | "write";

interface ToolSpec {
  name: string;
  argsKind: ArgsKind;
}

const sdkSessions = new Map<string, CursorSdkSession>();
const SDK_SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const AGENT_MODE_AGENT = 1;
const DEFAULT_SDK_CLIENT_VERSION = "sdk-1.0.13";
const DEFAULT_SDK_STREAM_START_TIMEOUT_MS = 25_000;
const DEFAULT_SDK_RUN_TIMEOUT_MS = 120_000;
const DEFAULT_SDK_STREAM_IDLE_TIMEOUT_MS = 60_000;

const TOOL_CALL_SPECS: Record<number, ToolSpec> = {
  1: { name: "shell", argsKind: "shell" },
  3: { name: "delete", argsKind: "delete" },
  4: { name: "glob", argsKind: "glob" },
  5: { name: "grep", argsKind: "grep" },
  8: { name: "read", argsKind: "readTool" },
  9: { name: "todowrite", argsKind: "updateTodos" },
  10: { name: "todoread", argsKind: "readTodos" },
  13: { name: "ls", argsKind: "ls" },
  14: { name: "readLints", argsKind: "readLints" },
  15: { name: "mcp", argsKind: "mcp" },
  16: { name: "semSearch", argsKind: "semSearch" },
  17: { name: "createPlan", argsKind: "createPlan" },
  18: { name: "websearch", argsKind: "webSearch" },
  19: { name: "task", argsKind: "task" },
  20: { name: "listMcpResources", argsKind: "listMcpResources" },
  21: { name: "readMcpResource", argsKind: "readMcpResource" },
  23: { name: "question", argsKind: "askQuestion" },
  24: { name: "webfetch", argsKind: "fetch" },
  25: { name: "switchMode", argsKind: "switchMode" },
  28: { name: "generateImage", argsKind: "generateImage" },
  37: { name: "webfetch", argsKind: "webFetch" },
  42: { name: "await", argsKind: "await" }
};

const UNSUPPORTED_TOOL_CALL_SPECS: Record<number, ToolSpec> = {
  22: { name: "recordGrind", argsKind: "unsupported" },
  29: { name: "reportBug", argsKind: "unsupported" },
  30: { name: "fixBug", argsKind: "unsupported" },
  31: { name: "prManagement", argsKind: "unsupported" },
  32: { name: "prReview", argsKind: "unsupported" },
  33: { name: "ciFix", argsKind: "unsupported" },
  34: { name: "ciStatus", argsKind: "unsupported" },
  35: { name: "ciLogs", argsKind: "unsupported" },
  36: { name: "ciRerun", argsKind: "unsupported" },
  38: { name: "ciCancel", argsKind: "unsupported" },
  39: { name: "ciApprove", argsKind: "unsupported" },
  40: { name: "ciMerge", argsKind: "unsupported" },
  41: { name: "ciComment", argsKind: "unsupported" },
  43: { name: "ciDeploy", argsKind: "unsupported" },
  44: { name: "ciRollback", argsKind: "unsupported" },
  45: { name: "ciPromote", argsKind: "unsupported" },
  46: { name: "ciRelease", argsKind: "unsupported" },
  48: { name: "ciTag", argsKind: "unsupported" },
  49: { name: "ciBranch", argsKind: "unsupported" },
  50: { name: "ciCheckout", argsKind: "unsupported" },
  51: { name: "ciCommit", argsKind: "unsupported" },
  52: { name: "ciPush", argsKind: "unsupported" },
  53: { name: "ciPull", argsKind: "unsupported" }
};

const UNSUPPORTED_TOOL_NAMES = new Set(Object.values(UNSUPPORTED_TOOL_CALL_SPECS).map((spec) => spec.name));

const EXEC_TOOL_SPECS: Record<number, ToolSpec> = {
  2: { name: "shell", argsKind: "shell" },
  3: { name: "write", argsKind: "write" },
  4: { name: "delete", argsKind: "delete" },
  5: { name: "grep", argsKind: "grep" },
  7: { name: "read", argsKind: "readExec" },
  8: { name: "ls", argsKind: "ls" },
  9: { name: "readLints", argsKind: "readLints" },
  11: { name: "mcp", argsKind: "mcp" },
  14: { name: "shell", argsKind: "shell" },
  16: { name: "shell", argsKind: "shell" },
  17: { name: "listMcpResources", argsKind: "listMcpResources" },
  18: { name: "readMcpResource", argsKind: "readMcpResource" },
  20: { name: "webfetch", argsKind: "fetch" }
};

export async function createCursorSdkCompletion(
  env: Env,
  deps: Deps,
  apiKey: string,
  input: { prompt: { text: string; images?: CursorImage[] }; model?: { id: string }; sessionKey?: string; sessionOwnerKey?: string }
): Promise<CursorSdkCompletion> {
  const accessToken = await exchangeCursorApiKey(env, deps, apiKey);
  const now = deps.now();
  pruneSessions(now.getTime());
  const sessionIdentity = await sdkSessionIdentity(apiKey, input.sessionKey || "default", input.sessionOwnerKey);
  const session = sdkSessions.get(sessionIdentity.id);
  const agentId = session?.agentId || newLocalSdkAgentId(deps.randomUUID());
  const runId = newLocalSdkRunId(deps.randomUUID());
  const updatedAt = deps.now();

  sdkSessions.set(sessionIdentity.id, { agentId, updatedAt: updatedAt.getTime() });

  return {
    agentId,
    runId,
    stream: streamCursorLocalSdkRun(env, deps, accessToken, {
      agentId,
      runId,
      prompt: sdkPrompt(input.prompt),
      modelId: input.model?.id || "composer-2.5"
    })
  };
}

export async function collectCursorSdkOutput(stream: AsyncIterable<CursorTextEvent>): Promise<CursorCollectedOutput> {
  let text = "";
  let toolCalls: CursorToolCall[] = [];
  for await (const event of stream) {
    if (event.type === "text" && event.text) text += event.text;
    if (event.type === "tool_call") toolCalls.push(event.toolCall);
    if (event.type === "done") {
      text = event.finalText;
      toolCalls = event.toolCalls;
    }
  }
  return { text, toolCalls };
}

export function resetCursorSdkSessionCacheForTest() {
  sdkSessions.clear();
}

export const cursorSdkTestExports = {
  decodeInteractionQuery,
  decodeLocalAgentServerFrame,
  decodeSdkToolCall,
  decodeToolCallUpdate,
  encodeAgentClientInteractionResponseApproved,
  encodeAgentClientRequestContextResult,
  encodeAgentClientRunRequest,
  formatHostedSdkToolResult,
  formatUnsupportedSdkToolMessage,
  isCursorHostedSdkToolCall,
  isEmittableSdkToolCall,
  isUnsupportedSdkToolCall,
  mergePendingSdkToolCall,
  normalizeSdkToolCallForOpenCode,
  parseConnectProtoFrames,
  sdkTimeoutMsFromEnv
};

function formatHostedSdkToolResult(
  kind: "websearch" | "webfetch",
  args: Record<string, unknown>,
  resultBytes: Uint8Array
): string {
  return kind === "websearch" ? formatWebSearchResult(args, resultBytes) : formatWebFetchResult(args, resultBytes);
}

async function* streamCursorLocalSdkRun(
  env: Env,
  deps: Deps,
  accessToken: string,
  input: { agentId: string; runId: string; prompt: string; modelId: string }
): AsyncGenerator<CursorTextEvent> {
  let text = "";
  const toolCalls: CursorToolCall[] = [];
  const emittedToolCallIds = new Set<string>();
  const emittedUnsupportedToolCallIds = new Set<string>();
  const pendingToolCalls = new Map<string, { toolCall: CursorToolCall; completed: boolean }>();
  const requestId = deps.randomUUID();
  const requestBody = encodeConnectFrame(
    encodeAgentClientRunRequest({
      agentId: input.agentId,
      messageId: input.runId,
      modelId: input.modelId,
      prompt: input.prompt
    })
  );
  const runAbort = new AbortController();
  const startTimeoutMs = sdkTimeoutMsFromEnv(env, "CURSOR_SDK_STREAM_START_TIMEOUT_MS", DEFAULT_SDK_STREAM_START_TIMEOUT_MS);
  const runTimeoutMs = sdkTimeoutMsFromEnv(env, "CURSOR_SDK_RUN_TIMEOUT_MS", DEFAULT_SDK_RUN_TIMEOUT_MS);
  const idleTimeoutMs = sdkTimeoutMsFromEnv(env, "CURSOR_SDK_STREAM_IDLE_TIMEOUT_MS", DEFAULT_SDK_STREAM_IDLE_TIMEOUT_MS);
  const runTimer = setTimeout(() => {
    runAbort.abort("cursor_sdk_run_timeout");
  }, runTimeoutMs);
  const bridgeUrl = env.CURSOR_SDK_BRIDGE_URL?.trim();
  const useBridge = Boolean(bridgeUrl);
  const upload = useBridge ? undefined : new TransformStream<Uint8Array, Uint8Array>();
  const uploadWriter = upload?.writable.getWriter();
  const runResponsePromise = (
    bridgeUrl
      ? cursorLocalSdkUrlBridgeRaw(env, deps, bridgeUrl, accessToken, requestId, requestBody, runAbort.signal)
      : cursorLocalSdkRaw(env, deps, cursorLocalSdkEndpoint(env), accessToken, requestId, upload!.readable, runAbort.signal)
  ).then((response) => ({
    source: "run" as const,
    response
  }));
  let uploadOpen = false;
  if (uploadWriter) {
    await writeSdkUpload(uploadWriter, requestBody);
    uploadOpen = true;
  }

  const selected = await withSdkStartTimeout(runResponsePromise, startTimeoutMs);
  const response = selected.response;

  try {
    let yieldedInFrame = false;
    let frameIndex = 0;
    let subagentActive = false;
    let subagentLastOutputTime = 0;
    let subagentIdleFrames = 0;
    const SUBAGENT_IDLE_FRAME_THRESHOLD = 3;
    const SUBAGENT_IDLE_TIME_MS = 5_000;
    let toolCallBatchDeadline: number | null = null;
    // The model often proposes multiple tool calls in sequence with several
    // hundred ms of token-delta frames between them. A 2s silence window
    // after the last emitted tool call ensures we batch all of them before
    // synthesizing done, while still being fast enough to avoid the ~30s
    // idle hang that occurs when the server waits for exec results we never
    // send (OpenCode executes tools and provides results via follow-up requests).
    const TOOL_CALL_BATCH_WINDOW_MS = 2_000;

    for await (const frame of parseConnectProtoFrames(response.body, { idleTimeoutMs, signal: runAbort.signal })) {
      yieldedInFrame = false;
      const events = decodeLocalAgentServerFrame(frame);
      const evtSummary = events.map((e) => e.type === "tool_call" ? `tool_call(${e.toolCall.name},completed=${e.completed})` : e.type).join(",");
      if (evtSummary === "ignore" && frame.length > 128) {
        const topFields = decodeProtobufFields(frame).map((f) => `${f.no}:${f.value instanceof Uint8Array ? `b(${f.value.length})` : `v(${f.value})`}`);
        console.log(`[sdk-debug] frame#${frameIndex} size=${frame.length} events=[ignore] topFields=[${topFields.join(",")}]`);
      } else {
        console.log(`[sdk-debug] frame#${frameIndex} size=${frame.length} events=[${evtSummary}]`);
      }
      let frameHasSubagentOutput = false;
      let frameHasContent = false;
      for (const event of events) {
        if (event.type === "text" && event.text) {
          text += event.text;
          yield { type: "text", text: event.text };
          yieldedInFrame = true;
          frameHasContent = true;
        } else if (event.type === "thinking" && event.text) {
          yield { type: "thinking", text: event.text };
          yieldedInFrame = true;
          frameHasContent = true;
        } else if (event.type === "subagent_output") {
          subagentActive = true;
          subagentLastOutputTime = Date.now();
          subagentIdleFrames = 0;
          frameHasSubagentOutput = true;
        } else if (event.type === "tool_call") {
          console.log(`[sdk-debug] tool_call id=${event.id} name=${event.toolCall.name} completed=${event.completed} args=${JSON.stringify(event.toolCall.arguments).slice(0, 200)}`);
          if (isUnsupportedSdkToolCall(event.toolCall)) {
            if (!emittedUnsupportedToolCallIds.has(event.id)) {
              emittedUnsupportedToolCallIds.add(event.id);
              const message = formatUnsupportedSdkToolMessage(event.toolCall.name);
              text += message;
              yield { type: "text", text: message };
              yieldedInFrame = true;
            }
            continue;
          }
          upsertPendingSdkToolCall(pendingToolCalls, event.id, event.toolCall, event.completed);
          frameHasContent = true;
          for (const emitted of emitCompletedPendingSdkToolCalls(pendingToolCalls, emittedToolCallIds, toolCalls)) {
            console.log(`[sdk-debug] emitting pending tool_call name=${emitted.type === "tool_call" ? emitted.toolCall.name : "?"}`);
            yield emitted;
            yieldedInFrame = true;
            toolCallBatchDeadline = Date.now() + TOOL_CALL_BATCH_WINDOW_MS;
          }
        } else if (event.type === "request_context") {
          console.log(`[sdk-debug] request_context id=${event.id}`);
          frameHasContent = true;
          if (uploadOpen && uploadWriter) {
            await writeSdkUpload(uploadWriter, encodeConnectFrame(encodeAgentClientRequestContextResult(event)));
          }
        } else if (event.type === "interaction_query") {
          console.log(`[sdk-debug] interaction_query id=${event.id} kind=${event.kind} fieldNo=${event.fieldNo}`);
          if (uploadOpen && uploadWriter) {
            await writeSdkUpload(uploadWriter, encodeConnectFrame(encodeAgentClientInteractionResponseApproved(event)));
            console.log(`[sdk-debug] sent approval for interaction_query id=${event.id}`);
          } else {
            console.warn(`[sdk-debug] cannot send approval: uploadOpen=${uploadOpen} uploadWriter=${!!uploadWriter}`);
          }
        } else if (event.type === "done") {
          console.log(`[sdk-debug] done event, pending=${pendingToolCalls.size} emitted=${emittedToolCallIds.size}`);
          for (const emitted of emitCompletedPendingSdkToolCalls(pendingToolCalls, emittedToolCallIds, toolCalls)) {
            yield emitted;
          }
          yield { type: "done", finalText: text, toolCalls };
          return;
        } else if (event.type === "ignore") {
          // no-op
        }
      }
      if (subagentActive && !frameHasSubagentOutput) {
        subagentIdleFrames++;
        const elapsedMs = Date.now() - subagentLastOutputTime;
        if (subagentIdleFrames >= SUBAGENT_IDLE_FRAME_THRESHOLD && elapsedMs >= SUBAGENT_IDLE_TIME_MS) {
          console.log(`[sdk-debug] subagent done (${subagentIdleFrames} idle frames, ${elapsedMs}ms elapsed), synthesizing done`);
          for (const emitted of emitCompletedPendingSdkToolCalls(pendingToolCalls, emittedToolCallIds, toolCalls)) {
            yield emitted;
          }
          yield { type: "done", finalText: text, toolCalls };
          return;
        }
      }
      if (frameHasContent) {
        if (toolCallBatchDeadline !== null) {
          toolCallBatchDeadline = Date.now() + TOOL_CALL_BATCH_WINDOW_MS;
        }
      } else if (toolCallBatchDeadline !== null && Date.now() >= toolCallBatchDeadline) {
        console.log(`[sdk-debug] tool call batch complete (emitted=${emittedToolCallIds.size}), synthesizing done`);
        for (const emitted of emitCompletedPendingSdkToolCalls(pendingToolCalls, emittedToolCallIds, toolCalls)) {
          yield emitted;
        }
        yield { type: "done", finalText: text, toolCalls };
        return;
      }
      if (!yieldedInFrame) {
        yield { type: "keepalive" as const };
      }
      frameIndex++;
    }
    console.log(`[sdk-debug] stream ended naturally after ${frameIndex} frames without done event`);
  } finally {
    clearTimeout(runTimer);
    if (uploadOpen && uploadWriter) await closeSdkUpload(uploadWriter);
    runAbort.abort("opencode_sdk_run_finished");
  }

  yield { type: "done", finalText: text, toolCalls };
}

async function cursorLocalSdkRaw(
  env: Env,
  deps: Deps,
  endpoint: string,
  accessToken: string,
  requestId: string,
  body: BodyInit,
  signal?: AbortSignal
): Promise<Response> {
  const base = env.CURSOR_BACKEND_BASE_URL?.trim();
  if (!base) throw new HttpError("Cursor backend URL is not configured", 500, "cursor_missing_backend_url");
  const url = /^https?:\/\//.test(endpoint) ? endpoint : `${base.replace(/\/$/, "")}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
  const headers = new Headers({
    Authorization: `Bearer ${accessToken}`,
    "Connect-Protocol-Version": "1",
    "Content-Type": "application/connect+proto",
    "User-Agent": "connect-es/1.6.1",
    "x-cursor-client-type": "sdk",
    "x-cursor-client-version": env.CURSOR_SDK_CLIENT_VERSION || DEFAULT_SDK_CLIENT_VERSION,
    "x-ghost-mode": "true",
    "x-original-request-id": requestId,
    "x-request-id": requestId
  });
  const init: RequestInit & { duplex?: "half" } = { method: "POST", headers, body, signal };
  if (body instanceof ReadableStream) init.duplex = "half";
  const response = await deps.fetch(url, init);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const parsed = parseCursorSdkError(text);
    const message = response.status === 401 ? "Invalid Cursor API key" : parsed.message || `Cursor local SDK request failed with status ${response.status}`;
    const status = response.status === 401 ? 401 : response.status === 429 ? 429 : response.status >= 500 ? 502 : 400;
    throw new HttpError(message, status, response.status === 401 ? "cursor_unauthorized" : parsed.code || "cursor_sdk_error");
  }
  return response;
}

async function cursorLocalSdkUrlBridgeRaw(
  env: Env,
  deps: Deps,
  bridgeUrl: string,
  accessToken: string,
  requestId: string,
  runFrame: Uint8Array,
  signal?: AbortSignal
): Promise<Response> {
  const response = await deps.fetch(bridgeUrl, {
    method: "POST",
    headers: cursorLocalSdkBridgeHeaders(env),
    signal,
    body: JSON.stringify(cursorLocalSdkBridgePayload(env, accessToken, requestId, runFrame))
  });
  return assertCursorLocalSdkBridgeResponse(response);
}

function cursorLocalSdkBridgeHeaders(env: Env): Headers {
  const headers = new Headers({
    "Content-Type": "application/json"
  });
  if (env.CURSOR_SDK_BRIDGE_TOKEN?.trim()) {
    headers.set("Authorization", `Bearer ${env.CURSOR_SDK_BRIDGE_TOKEN.trim()}`);
  }
  return headers;
}

function cursorLocalSdkBridgePayload(env: Env, accessToken: string, requestId: string, runFrame: Uint8Array): Record<string, string> {
  const backendBaseUrl = env.CURSOR_BACKEND_BASE_URL?.trim();
  if (!backendBaseUrl) throw new HttpError("Cursor backend URL is not configured", 500, "cursor_missing_backend_url");
  return {
    accessToken,
    requestId,
    backendBaseUrl,
    localAgentEndpoint: cursorLocalSdkEndpoint(env),
    clientVersion: env.CURSOR_SDK_CLIENT_VERSION || DEFAULT_SDK_CLIENT_VERSION,
    runFrame: bytesToBase64(runFrame)
  };
}

async function assertCursorLocalSdkBridgeResponse(response: Response): Promise<Response> {
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const parsed = parseCursorSdkError(text);
    const message = response.status === 401 ? "Cursor SDK bridge rejected the request" : parsed.message || `Cursor SDK bridge failed with status ${response.status}`;
    const status = response.status === 401 ? 502 : response.status === 429 ? 429 : response.status >= 500 ? 502 : 400;
    throw new HttpError(message, status, parsed.code || "cursor_sdk_bridge_error");
  }
  return response;
}

async function writeSdkUpload(writer: WritableStreamDefaultWriter<Uint8Array>, frame: Uint8Array): Promise<void> {
  await writer.write(frame).catch((error) => {
    throw error instanceof Error ? error : new Error(String(error));
  });
}

async function closeSdkUpload(writer: WritableStreamDefaultWriter<Uint8Array>): Promise<void> {
  await writer.close().catch(() => undefined);
  writer.releaseLock();
}

function withSdkStartTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new HttpError("Cursor local SDK stream did not start.", 504, "cursor_sdk_stream_timeout"));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function sdkTimeoutMsFromEnv(env: Env, key: keyof Env, fallback: number): number {
  const raw = env[key];
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function throwIfSdkStreamAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw sdkStreamAbortError(signal);
}

function sdkStreamAbortError(signal?: AbortSignal): HttpError {
  const reason = typeof signal?.reason === "string" ? signal.reason : "";
  if (reason === "cursor_sdk_run_timeout") {
    return new HttpError("Cursor local SDK run timed out.", 504, "cursor_sdk_run_timeout");
  }
  return new HttpError("Cursor local SDK stream aborted.", 504, "cursor_sdk_stream_aborted");
}

async function readStreamChunkWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
  signal?: AbortSignal
): Promise<ReadableStreamReadResult<Uint8Array>> {
  throwIfSdkStreamAborted(signal);
  if (idleTimeoutMs <= 0) {
    return reader.read();
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const settle = (result: ReadableStreamReadResult<Uint8Array>) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const timer = setTimeout(() => {
      fail(new HttpError("Cursor local SDK stream timed out waiting for data.", 504, "cursor_sdk_stream_idle_timeout"));
    }, idleTimeoutMs);
    const onAbort = () => {
      fail(sdkStreamAbortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    reader.read().then(settle, fail);
  });
}

function cursorLocalSdkEndpoint(env: Env): string {
  const endpoint = env.CURSOR_LOCAL_AGENT_ENDPOINT?.trim();
  if (!endpoint) throw new HttpError("Cursor local SDK endpoint is not configured", 500, "cursor_missing_endpoint");
  return endpoint;
}

function encodeAgentClientRunRequest(input: { agentId: string; messageId: string; modelId: string; prompt: string }): Uint8Array {
  const userMessage = protoMessage([
    protoStringField(1, input.prompt),
    protoStringField(2, input.messageId),
    protoVarintField(4, AGENT_MODE_AGENT)
  ]);
  const userMessageAction = protoMessage([protoMessageField(1, userMessage)]);
  const conversationAction = protoMessage([protoMessageField(1, userMessageAction)]);
  const modelDetails = protoMessage([
    protoStringField(1, input.modelId),
    protoStringField(3, input.modelId),
    protoStringField(4, input.modelId)
  ]);
  const requestedModel = protoMessage([protoStringField(1, input.modelId)]);
  const runRequest = protoMessage([
    protoMessageField(1, protoMessage([])),
    protoMessageField(2, conversationAction),
    protoMessageField(3, modelDetails),
    protoMessageField(4, protoMessage([])),
    protoStringField(5, input.agentId),
    protoStringField(13, "sdk"),
    protoMessageField(9, requestedModel),
    protoVarintField(19, 1)
  ]);
  return protoMessage([protoMessageField(1, runRequest)]);
}

function encodeAgentClientInteractionResponseApproved(input: { id: number; kind: InteractionQueryKind; fieldNo: number }): Uint8Array {
  const approved = protoMessage([]);
  const wrapper = protoMessage([protoMessageField(1, approved)]);
  const interactionResponse = protoMessage([
    protoVarintField(1, input.id),
    protoMessageField(input.fieldNo, wrapper)
  ]);
  return protoMessage([protoMessageField(6, interactionResponse)]);
}

function encodeAgentClientRequestContextResult(input: { id: number; execId?: string }): Uint8Array {
  const env = protoMessage([
    protoStringField(1, "OpenCode local server"),
    protoStringField(2, "."),
    protoStringField(3, "sh"),
    protoVarintField(5, false),
    protoStringField(10, "UTC"),
    protoStringField(11, "."),
    protoStringField(21, ".")
  ]);
  const requestContext = protoMessage([
    protoMessageField(4, env),
    protoVarintField(17, true),
    protoVarintField(24, true),
    protoVarintField(32, true),
    protoVarintField(33, true),
    protoVarintField(35, true),
    protoVarintField(36, true),
    protoVarintField(39, true),
    protoVarintField(40, true),
    protoVarintField(41, true),
    protoVarintField(42, true),
    protoVarintField(43, true),
    protoVarintField(44, true),
    protoVarintField(45, true)
  ]);
  const success = protoMessage([protoMessageField(1, requestContext)]);
  const result = protoMessage([protoMessageField(1, success)]);
  const execClientMessage = protoMessage([
    protoVarintField(1, input.id),
    protoStringField(15, input.execId),
    protoMessageField(10, result)
  ]);
  return protoMessage([protoMessageField(2, execClientMessage)]);
}

function decodeLocalAgentServerFrame(payload: Uint8Array): LocalSdkDecodedEvent[] {
  const output: LocalSdkDecodedEvent[] = [];
  try {
    for (const field of decodeProtobufFields(payload)) {
      if (field.no === 1 && field.value instanceof Uint8Array) {
        output.push(...decodeInteractionUpdate(field.value));
      } else if (field.no === 2 && field.value instanceof Uint8Array) {
        const event = decodeExecServerMessage(field.value);
        if (event) {
          output.push(event);
        } else {
          console.log(`[sdk-debug] exec server message produced no event, size=${field.value.length}`);
        }
      } else if (field.no === 7 && field.value instanceof Uint8Array) {
        const event = decodeInteractionQuery(field.value);
        if (event) output.push(event);
      } else if (field.value instanceof Uint8Array) {
        console.warn(`[sdk-debug] unhandled server frame field no=${field.no} size=${field.value.length} dump=${dumpProtoFields(field.value, 2)}`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not decode Cursor local SDK stream";
    throw new HttpError(message, 502, "cursor_stream_error");
  }
  return output.length ? output : [{ type: "ignore" }];
}

function decodeInteractionQuery(payload: Uint8Array): LocalSdkDecodedEvent | null {
  const fields = decodeProtobufFields(payload);
  const id = numberField(fields, 1) || 0;
  for (const [kind, fieldNo] of Object.entries(INTERACTION_QUERY_FIELD_BY_KIND) as Array<[InteractionQueryKind, number]>) {
    if (fields.some((field) => field.no === fieldNo && field.value instanceof Uint8Array)) {
      return { type: "interaction_query", id, kind, fieldNo };
    }
  }
  for (const field of fields) {
    if (field.no !== 1 && field.value instanceof Uint8Array) {
      console.warn(`[cursor-sdk] auto-approving unknown interaction query field ${field.no}`);
      return { type: "interaction_query", id, kind: "websearch", fieldNo: field.no };
    }
  }
  return null;
}

function decodeExecServerMessage(payload: Uint8Array): LocalSdkDecodedEvent | null {
  const fields = decodeProtobufFields(payload);
  if (fields.some((field) => field.no === 10 && field.value instanceof Uint8Array)) {
    return {
      type: "request_context",
      id: numberField(fields, 1) || 0,
      execId: stringField(fields, 15)
    };
  }
  const toolCall = decodeExecServerToolCall(payload, fields);
  if (!toolCall) {
    const fieldNos = fields.map((f) => `${f.no}(${f.value instanceof Uint8Array ? `${f.value.length}B` : `v=${f.value}`})`).join(",");
    console.log(`[sdk-debug] decodeExecServerMessage returned null, fields=[${fieldNos}]`);
  }
  return toolCall;
}

function decodeInteractionUpdate(payload: Uint8Array): LocalSdkDecodedEvent[] {
  const output: LocalSdkDecodedEvent[] = [];
  for (const field of decodeProtobufFields(payload)) {
    if (!(field.value instanceof Uint8Array)) continue;
    if (field.no === 1) {
      const text = stringField(decodeProtobufFields(field.value), 1);
      if (text) output.push({ type: "text", text });
    } else if (field.no === 2 || field.no === 3 || field.no === 7) {
      const event = decodeToolCallUpdate(field.value, field.no === 3);
      if (event) {
        output.push(event);
      } else {
        console.log(`[sdk-debug] decodeToolCallUpdate returned null for interaction field=${field.no} (completed=${field.no === 3})`);
      }
    } else if (field.no === 4) {
      const thinkingText = stringField(decodeProtobufFields(field.value), 1);
      if (thinkingText) output.push({ type: "thinking", text: thinkingText });
    } else if (field.no === 14) {
      output.push({ type: "done" });
    } else if (field.no === 15) {
      const subFields = decodeProtobufFields(field.value);
      const toolCallId = stringField(subFields, 1) || "";
      const dataField = subFields.find((f) => f.no === 2 && f.value instanceof Uint8Array);
      if (dataField && dataField.value instanceof Uint8Array) {
        const dataText = stringField(decodeProtobufFields(dataField.value as Uint8Array), 2);
        if (toolCallId && dataText) {
          output.push({ type: "subagent_output", toolCallId, text: dataText });
        }
      }
    } else {
      console.log(`[sdk-debug] unhandled interaction update field no=${field.no} size=${field.value.length} dump=${dumpProtoFields(field.value, 2)}`);
    }
  }
  return output;
}

function decodeToolCallUpdate(payload: Uint8Array, completed: boolean): LocalSdkDecodedEvent | null {
  const fields = decodeProtobufFields(payload);
  const callId = stringField(fields, 1) || stableToolCallId(payload);
  const toolCallBytes = bytesField(fields, 2);
  if (!toolCallBytes) { console.log(`[sdk-debug] decodeToolCallUpdate: no toolCallBytes, callId=${callId}`); return null; }
  const decoded = decodeSdkToolCall(toolCallBytes);
  if (!decoded) { console.log(`[sdk-debug] decodeToolCallUpdate: decodeSdkToolCall returned null, callId=${callId}`); return null; }
  console.log(`[sdk-debug] decodeToolCallUpdate: callId=${callId} name=${decoded.toolCall.name} completed=${completed} hasResult=${decoded.hasResult} forwarded=${isSdkToolCallForwardedToClient(decoded.toolCall)}`);
  if (completed && decoded.hasResult) {
    const hostedText = decodeCursorHostedToolResultText(decoded.toolCall, toolCallBytes);
    if (hostedText) return { type: "text", text: hostedText };
    if (!isSdkToolCallForwardedToClient(decoded.toolCall)) {
      console.log(`[sdk-debug] dropping completed non-forwarded tool: ${decoded.toolCall.name}`);
      return null;
    }
    console.log(`[sdk-debug] passing through completed forwarded tool: ${decoded.toolCall.name}`);
  }
  if (isCursorHostedSdkToolCall(decoded.toolCall)) return null;
  if (isUnsupportedSdkToolCall(decoded.toolCall)) {
    return { type: "tool_call", id: callId, toolCall: decoded.toolCall, completed };
  }
  return {
    type: "tool_call",
    id: callId,
    toolCall: normalizeSdkToolCallForOpenCode(decoded.toolCall),
    completed
  };
}

function decodeSdkToolCall(payload: Uint8Array): { toolCall: CursorToolCall; hasResult: boolean } | null {
  for (const field of decodeProtobufFields(payload)) {
    if (!(field.value instanceof Uint8Array)) continue;
    const spec = TOOL_CALL_SPECS[field.no] || UNSUPPORTED_TOOL_CALL_SPECS[field.no];
    if (!spec) {
      console.warn(`[cursor-sdk] unknown tool field number ${field.no}`);
      continue;
    }
    const toolFields = decodeProtobufFields(field.value);
    const args = bytesField(toolFields, 1);
    const hasResult = toolFields.some((item) => item.no === 2);
    return {
      hasResult,
      toolCall: {
        name: spec.name,
        arguments: args ? decodeToolArgs(spec.argsKind, args) : {}
      }
    };
  }
  return null;
}

function decodeExecServerToolCall(payload: Uint8Array, fields = decodeProtobufFields(payload)): LocalSdkDecodedEvent | null {
  const id = numberField(fields, 1);
  const execId = stringField(fields, 15);
  for (const field of fields) {
    if (!(field.value instanceof Uint8Array)) continue;
    const spec = EXEC_TOOL_SPECS[field.no];
    if (!spec) continue;
    const args = decodeToolArgs(spec.argsKind, field.value);
    const toolCallId = stringArg(args, "toolCallId") || execId || `exec_${id ?? stableToolCallId(payload)}`;
    delete args.toolCallId;
    return {
      type: "tool_call",
      id: toolCallId,
      toolCall: normalizeSdkToolCallForOpenCode({ name: spec.name, arguments: args }),
      completed: true
    };
  }
  return null;
}

function normalizeSdkToolCallForOpenCode(toolCall: CursorToolCall): CursorToolCall {
  return toolCall;
}

function decodeToolArgs(kind: ArgsKind, payload: Uint8Array): Record<string, unknown> {
  const fields = decodeProtobufFields(payload);
  switch (kind) {
    case "shell":
      return compactRecord({
        command: stringField(fields, 1),
        workingDirectory: stringField(fields, 2),
        timeout: numberField(fields, 3),
        toolCallId: stringField(fields, 4)
      });
    case "write":
      return compactRecord({
        path: stringField(fields, 1),
        fileText: stringField(fields, 2),
        toolCallId: stringField(fields, 3),
        returnFileContentAfterWrite: booleanField(fields, 4)
      });
    case "delete":
      return compactRecord({ path: stringField(fields, 1), toolCallId: stringField(fields, 2) });
    case "glob":
      return compactRecord({ targetDirectory: stringField(fields, 1), globPattern: stringField(fields, 2) });
    case "grep":
      return compactRecord({
        pattern: stringField(fields, 1),
        path: stringField(fields, 2),
        glob: stringField(fields, 3),
        outputMode: stringField(fields, 4),
        contextBefore: numberField(fields, 5),
        contextAfter: numberField(fields, 6),
        context: numberField(fields, 7),
        caseInsensitive: booleanField(fields, 8),
        type: stringField(fields, 9),
        headLimit: numberField(fields, 10),
        multiline: booleanField(fields, 11),
        sort: stringField(fields, 12),
        sortAscending: booleanField(fields, 13),
        toolCallId: stringField(fields, 14),
        offset: numberField(fields, 16)
      });
    case "readTool":
      return compactRecord({
        path: stringField(fields, 1),
        offset: numberField(fields, 2),
        limit: numberField(fields, 3),
        includeLineNumbers: booleanField(fields, 5)
      });
    case "readExec":
      return compactRecord({
        path: stringField(fields, 1),
        toolCallId: stringField(fields, 2),
        offset: numberField(fields, 4),
        limit: numberField(fields, 5)
      });
    case "ls":
      return compactRecord({ path: stringField(fields, 1), ignore: stringFields(fields, 2), toolCallId: stringField(fields, 3) });
    case "readLints":
      return compactRecord({ paths: stringFields(fields, 1) });
    case "mcp":
      return compactRecord({
        providerIdentifier: stringField(fields, 1),
        toolName: stringField(fields, 2),
        toolCallId: stringField(fields, 4)
      });
    case "semSearch":
      return compactRecord({
        query: stringField(fields, 1),
        targetDirectories: stringFields(fields, 2),
        explanation: stringField(fields, 3)
      });
    case "task":
      return compactRecord({
        description: stringField(fields, 1),
        prompt: stringField(fields, 2),
        subagent_type: normalizeSubagentTypeForOpenCode(decodeSubagentType(bytesField(fields, 3))),
        task_id: stringField(fields, 5)
      });
    case "webFetch":
    case "fetch":
      return compactRecord({ url: stringField(fields, 1) });
    case "webSearch":
      return compactRecord({ query: stringField(fields, 1) });
    case "updateTodos":
      return compactRecord({
        todos: repeatedMessageFields(fields, 1).map(decodeTodoItem).filter((item) => hasStringArg(item, "content"))
      });
    case "askQuestion":
      return compactRecord({
        questions: repeatedMessageFields(fields, 2).map(decodeAskQuestionItem).filter((item) => hasStringArg(item, "question"))
      });
    case "readTodos":
      return compactRecord({ merge: booleanField(fields, 1), toolCallId: stringField(fields, 2) });
    case "createPlan":
      return compactRecord({ plan: stringField(fields, 1), toolCallId: stringField(fields, 2) });
    case "listMcpResources":
      return compactRecord({ server: stringField(fields, 1), toolCallId: stringField(fields, 2) });
    case "readMcpResource":
      return compactRecord({
        server: stringField(fields, 1),
        uri: stringField(fields, 2),
        downloadPath: stringField(fields, 3),
        toolCallId: stringField(fields, 4)
      });
    case "switchMode":
      return compactRecord({ targetModeId: stringField(fields, 1), explanation: stringField(fields, 2) });
    case "generateImage":
      return compactRecord({
        description: stringField(fields, 1),
        filename: stringField(fields, 2),
        toolCallId: stringField(fields, 3)
      });
    case "await":
      return compactRecord({ shellId: stringField(fields, 1), pattern: stringField(fields, 2), toolCallId: stringField(fields, 3) });
    case "unsupported":
      return {};
  }
}

function upsertPendingSdkToolCall(
  pendingToolCalls: Map<string, { toolCall: CursorToolCall; completed: boolean }>,
  id: string,
  toolCall: CursorToolCall,
  completed: boolean
): void {
  const existing = pendingToolCalls.get(id);
  if (!existing) {
    pendingToolCalls.set(id, { toolCall, completed });
    return;
  }
  pendingToolCalls.set(id, {
    toolCall: mergePendingSdkToolCall(existing.toolCall, toolCall),
    completed: existing.completed || completed
  });
}

function mergePendingSdkToolCall(existing: CursorToolCall, incoming: CursorToolCall): CursorToolCall {
  const mergedArgs: Record<string, unknown> = { ...(existing.arguments ?? {}), ...(incoming.arguments ?? {}) };
  const existingStream = stringArg(existing.arguments ?? {}, "streamContent");
  const incomingStream = stringArg(incoming.arguments ?? {}, "streamContent");
  if (existingStream !== undefined && incomingStream !== undefined) {
    mergedArgs.streamContent = incomingStream.length >= existingStream.length ? incomingStream : existingStream;
  }
  return {
    name: incoming.name || existing.name,
    arguments: mergedArgs
  };
}

function isPendingSdkToolCallReady(pending: { toolCall: CursorToolCall; completed: boolean }): boolean {
  if (pending.completed) return true;
  return isEmittableSdkToolCall(pending.toolCall);
}

function* emitCompletedPendingSdkToolCalls(
  pendingToolCalls: Map<string, { toolCall: CursorToolCall; completed: boolean }>,
  emittedToolCallIds: Set<string>,
  toolCalls: CursorToolCall[]
): Generator<CursorTextEvent> {
  for (const [id, pending] of pendingToolCalls) {
    if (!isPendingSdkToolCallReady(pending) || emittedToolCallIds.has(id) || !isEmittableSdkToolCall(pending.toolCall)) continue;
    emittedToolCallIds.add(id);
    const normalized = normalizeSdkToolCallForOpenCode(pending.toolCall);
    toolCalls.push(normalized);
    yield { type: "tool_call", toolCall: normalized };
  }
}

function isUnsupportedSdkToolCall(toolCall: CursorToolCall): boolean {
  return UNSUPPORTED_TOOL_NAMES.has(toolCall.name);
}

function formatUnsupportedSdkToolMessage(toolName: string): string {
  return `\n\nTool "${toolName}" is not available in this environment. Use an alternative approach or ask the user for guidance.\n\n`;
}

function decodeTodoItem(payload: Uint8Array): Record<string, unknown> {
  const fields = decodeProtobufFields(payload);
  return compactRecord({
    content: stringField(fields, 2) || stringField(fields, 1),
    status: mapTodoStatus(numberField(fields, 3)),
    priority: "medium"
  });
}

function mapTodoStatus(value: number | undefined): string {
  switch (value) {
    case 2:
      return "in_progress";
    case 3:
      return "completed";
    case 4:
      return "cancelled";
    default:
      return "pending";
  }
}

function decodeAskQuestionItem(payload: Uint8Array): Record<string, unknown> {
  const fields = decodeProtobufFields(payload);
  const prompt = stringField(fields, 2) || "";
  const id = stringField(fields, 1) || "";
  const options = repeatedMessageFields(fields, 3).map(decodeAskQuestionOption);
  return compactRecord({
    question: prompt,
    header: truncateHeader(id || prompt),
    ...(options.length ? { options } : {}),
    ...(booleanField(fields, 4) ? { multiple: true } : {})
  });
}

function decodeAskQuestionOption(payload: Uint8Array): Record<string, unknown> {
  const fields = decodeProtobufFields(payload);
  const label = stringField(fields, 2) || stringField(fields, 1) || "";
  return { label, description: label };
}

function truncateHeader(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 30) return trimmed;
  return trimmed.slice(0, 30);
}

function decodeSubagentType(payload: Uint8Array | undefined): string | undefined {
  if (!payload?.length) return undefined;
  for (const field of decodeProtobufFields(payload)) {
    if (!(field.value instanceof Uint8Array)) continue;
    switch (field.no) {
      case 1:
        return "unspecified";
      case 2:
        return "computer_use";
      case 3:
        return stringField(decodeProtobufFields(field.value), 1);
      case 4:
        return "explore";
      case 5:
        return "media_review";
      case 6:
        return "bash";
      case 7:
        return "browser_use";
      case 8:
        return "shell";
      case 9:
        return "vm_setup_helper";
      case 10:
        return "debug";
      case 11:
        return "cursor-guide";
      case 12:
        return "watch_video";
      default:
        return `subagent_field_${field.no}`;
    }
  }
  return undefined;
}

function normalizeSubagentTypeForOpenCode(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const aliases: Record<string, string> = {
    generalPurpose: "general",
    "general-purpose": "general",
    general_purpose: "general",
    unspecified: "general"
  };
  return aliases[trimmed] ?? trimmed;
}

function isCursorHostedSdkToolCall(toolCall: CursorToolCall): boolean {
  const name = toolCall.name.toLowerCase();
  return name === "websearch" || name === "webfetch";
}

const CLIENT_FORWARDED_TOOL_NAMES = new Set(["task", "todowrite", "question"]);

function isSdkToolCallForwardedToClient(toolCall: CursorToolCall): boolean {
  return CLIENT_FORWARDED_TOOL_NAMES.has(toolCall.name.toLowerCase());
}

function decodeCursorHostedToolResultText(toolCall: CursorToolCall, toolCallBytes: Uint8Array): string | null {
  for (const field of decodeProtobufFields(toolCallBytes)) {
    if (!(field.value instanceof Uint8Array)) continue;
    const spec = TOOL_CALL_SPECS[field.no];
    if (!spec) continue;
    const toolFields = decodeProtobufFields(field.value);
    const resultBytes = bytesField(toolFields, 2);
    if (!resultBytes) return null;
    switch (spec.argsKind) {
      case "webSearch":
        return formatWebSearchResult(toolCall.arguments ?? {}, resultBytes);
      case "webFetch":
      case "fetch":
        return formatWebFetchResult(toolCall.arguments ?? {}, resultBytes);
    }
  }
  return null;
}

function formatWebSearchResult(args: Record<string, unknown>, resultBytes: Uint8Array): string {
  const query = stringArg(args, "query") || "unknown";
  const fields = decodeProtobufFields(resultBytes);
  const successBytes = bytesField(fields, 1);
  if (successBytes) {
    const references = repeatedMessageFields(decodeProtobufFields(successBytes), 1);
    const lines = [`CURSOR WEB SEARCH RESULT (query: ${JSON.stringify(query)}):`];
    if (!references.length) lines.push("- No references returned.");
    for (const reference of references) {
      const refFields = decodeProtobufFields(reference);
      const title = stringField(refFields, 1) || "Untitled";
      const url = stringField(refFields, 2) || "";
      const chunk = stringField(refFields, 3) || "";
      lines.push(`- ${title}${url ? ` (${url})` : ""}`);
      if (chunk) lines.push(`  ${normalizeResultMarkup(chunk)}`);
    }
    return delimitHostedToolResult(lines.join("\n"));
  }
  const errorBytes = bytesField(fields, 2);
  if (errorBytes) {
    const error = stringField(decodeProtobufFields(errorBytes), 1) || "Web search failed";
    return delimitHostedToolResult(`CURSOR WEB SEARCH ERROR (query: ${JSON.stringify(query)}): ${error}`);
  }
  return delimitHostedToolResult(`CURSOR WEB SEARCH RESULT (query: ${JSON.stringify(query)}): [rejected or empty]`);
}

function formatWebFetchResult(args: Record<string, unknown>, resultBytes: Uint8Array): string {
  const requestedUrl = stringArg(args, "url") || "unknown";
  const fields = decodeProtobufFields(resultBytes);
  const successBytes = bytesField(fields, 1);
  if (successBytes) {
    const successFields = decodeProtobufFields(successBytes);
    const url = stringField(successFields, 1) || requestedUrl;
    const markdown = stringField(successFields, 2) || "";
    const body = markdown
      ? truncateHostedBody(collapseEllipsisMarkers(normalizeResultMarkup(markdown)), HOSTED_FETCH_BODY_LIMIT)
      : "[empty body]";
    return delimitHostedToolResult([`CURSOR WEB FETCH RESULT (url: ${JSON.stringify(url)}):`, body].join("\n"));
  }
  const errorBytes = bytesField(fields, 2);
  if (errorBytes) {
    const errorFields = decodeProtobufFields(errorBytes);
    const url = stringField(errorFields, 1) || requestedUrl;
    const error = stringField(errorFields, 2) || "Web fetch failed";
    return delimitHostedToolResult(`CURSOR WEB FETCH ERROR (url: ${JSON.stringify(url)}): ${error}`);
  }
  return delimitHostedToolResult(`CURSOR WEB FETCH RESULT (url: ${JSON.stringify(requestedUrl)}): [rejected or empty]`);
}

function delimitHostedToolResult(text: string): string {
  const trimmed = text.replace(/\s+$/u, "");
  return `\n\n${trimmed}\n\n`;
}

const HOSTED_RESULT_BODY_LIMIT = 1200;
const HOSTED_FETCH_BODY_LIMIT = 6000;

function normalizeResultMarkup(text: string): string {
  return prettifyResultBlocks(text)
    .replace(/<\/result>(?!\s)/g, "</result>\n")
    .replace(/<result\b([^>]*)>(?!\s)/g, "<result$1>\n");
}

function prettifyResultBlocks(text: string): string {
  return text.replace(
    /<result\s+id="(\d+)"\s*>\s*<title>([\s\S]*?)<\/title>\s*<url>([\s\S]*?)<\/url>\s*<content>([\s\S]*?)<\/content>\s*<\/result>/g,
    (_match, id: string, rawTitle: string, rawUrl: string, rawContent: string) => {
      const title = decodeHostedXmlEntities(rawTitle).trim();
      const url = decodeHostedXmlEntities(rawUrl).trim();
      const body = truncateHostedBody(collapseEllipsisMarkers(decodeHostedXmlEntities(rawContent)).trim(), HOSTED_RESULT_BODY_LIMIT);
      const header = `### ${id}. ${title || "Untitled"}`;
      const lines = [header];
      if (url) lines.push(url);
      if (body) {
        lines.push("");
        lines.push(body);
      }
      return lines.join("\n");
    }
  );
}

function collapseEllipsisMarkers(text: string): string {
  return text.replace(/(?:\s*\[\.\.\.\]\s*\n)+/g, "\n…\n").replace(/\[\.\.\.\]/g, "…");
}

function truncateHostedBody(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const head = text.slice(0, maxLength).replace(/\s+\S*$/u, "").trimEnd();
  return `${head} …`;
}

function decodeHostedXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function isEmittableSdkToolCall(toolCall: CursorToolCall): boolean {
  if (isUnsupportedSdkToolCall(toolCall)) return false;
  if (isCursorHostedSdkToolCall(toolCall)) return false;
  const name = toolCall.name.toLowerCase();
  const args = toolCall.arguments ?? {};
  if (name === "glob") return hasStringArg(args, "globPattern") || hasStringArg(args, "targetDirectory");
  if (name === "ls") return true;
  if (name === "shell") return hasStringArg(args, "command");
  if (name === "write") return hasStringArg(args, "path") && hasStringArg(args, "fileText");
  if (name === "read" || name === "delete") return hasStringArg(args, "path");
  if (name === "grep") return hasStringArg(args, "pattern");
  if (name === "semSearch") return hasStringArg(args, "query");
  if (name === "readLints") return Array.isArray(args.paths) && args.paths.some((item) => typeof item === "string" && item.trim());
  if (name === "mcp") return hasStringArg(args, "toolName") || hasStringArg(args, "providerIdentifier");
  if (name === "task") {
    return hasStringArg(args, "description") && hasStringArg(args, "prompt") && hasStringArg(args, "subagent_type");
  }
  if (name === "todowrite") {
    return Array.isArray(args.todos) && args.todos.some((item) => isRecord(item) && hasStringArg(item, "content"));
  }
  if (name === "question") {
    return (
      Array.isArray(args.questions) &&
      args.questions.some((item) => isRecord(item) && hasStringArg(item, "question") && hasStringArg(item, "header"))
    );
  }
  return Object.keys(args).length > 0;
}

function hasStringArg(args: Record<string, unknown>, key: string): boolean {
  return typeof args[key] === "string" && args[key].trim().length > 0;
}

function sdkPrompt(prompt: { text: string; images?: CursorImage[] }): string {
  if (!prompt.images?.length) return prompt.text;
  return `${prompt.text}\n\n[${prompt.images.length} image input${prompt.images.length === 1 ? "" : "s"} attached by the OpenAI-compatible client.]`;
}

function parseCursorSdkError(text: string): { message?: string; code?: string } {
  try {
    const payload = JSON.parse(text) as unknown;
    if (isRecord(payload)) {
      const error = isRecord(payload.error) ? payload.error : payload;
      return {
        message: typeof error.message === "string" ? error.message : undefined,
        code: typeof error.code === "string" ? error.code : undefined
      };
    }
  } catch {
    // Ignore JSON parse failures.
  }
  return { message: text || undefined };
}

async function sdkSessionIdentity(
  apiKey: string,
  sessionKey: string,
  sessionOwnerKey?: string
): Promise<{ id: string; ownerHash: string; sessionHash: string }> {
  const ownerHash = await sha256Hex(sessionOwnerKey || `cursor-key:${await sha256Hex(apiKey)}`);
  const sessionHash = await sha256Hex(sessionKey);
  return {
    id: await sha256Hex(`${ownerHash}\n${sessionHash}`),
    ownerHash,
    sessionHash
  };
}

function pruneSessions(now: number) {
  for (const [key, session] of sdkSessions) {
    if (session.updatedAt + SDK_SESSION_TTL_MS < now) sdkSessions.delete(key);
  }
}

function newLocalSdkAgentId(uuid: string): string {
  return uuid.startsWith("agent-") ? uuid : `agent-${uuid}`;
}

function newLocalSdkRunId(uuid: string): string {
  return uuid.startsWith("run-") ? uuid : `run-${uuid}`;
}

function protoMessage(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function protoMessageField(fieldNumber: number, value: Uint8Array): Uint8Array {
  return protoLengthDelimitedField(fieldNumber, value);
}

function protoStringField(fieldNumber: number, value: string | undefined): Uint8Array {
  if (value === undefined) return new Uint8Array(0);
  return protoLengthDelimitedField(fieldNumber, new TextEncoder().encode(value));
}

function protoLengthDelimitedField(fieldNumber: number, value: Uint8Array): Uint8Array {
  return protoMessage([varint((fieldNumber << 3) | 2), varint(value.length), value]);
}

function protoVarintField(fieldNumber: number, value: number | boolean | undefined): Uint8Array {
  if (value === undefined) return new Uint8Array(0);
  return protoMessage([varint(fieldNumber << 3), varint(value === true ? 1 : value === false ? 0 : value)]);
}

function varint(value: number): Uint8Array {
  const bytes: number[] = [];
  let current = value >>> 0;
  while (current >= 0x80) {
    bytes.push((current & 0x7f) | 0x80);
    current >>>= 7;
  }
  bytes.push(current);
  return new Uint8Array(bytes);
}

function encodeConnectFrame(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + payload.length);
  frame[0] = 0;
  new DataView(frame.buffer).setUint32(1, payload.length, false);
  frame.set(payload, 5);
  return frame;
}

async function* parseConnectProtoFrames(
  stream: ReadableStream<Uint8Array> | null,
  options: { idleTimeoutMs?: number; signal?: AbortSignal } = {}
): AsyncGenerator<Uint8Array> {
  if (!stream) return;
  const reader = stream.getReader();
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_SDK_STREAM_IDLE_TIMEOUT_MS;
  let buffer = new Uint8Array(0);
  try {
    for (;;) {
      const { value, done } = await readStreamChunkWithTimeout(reader, idleTimeoutMs, options.signal);
      if (done) break;
      if (value) buffer = concatBytes(buffer, value);
      for (;;) {
        if (buffer.length < 5) break;
        const flags = buffer[0];
        const length = new DataView(buffer.buffer, buffer.byteOffset + 1, 4).getUint32(0, false);
        if (buffer.length < 5 + length) break;
        const payload = buffer.slice(5, 5 + length);
        buffer = buffer.slice(5 + length);
        if ((flags & 1) === 1) {
          throw new HttpError("Cursor returned a compressed SDK frame that this Worker cannot decode.", 502, "cursor_stream_error");
        }
        if ((flags & 2) === 2) {
          handleEndStreamFrame(payload);
          continue;
        }
        yield payload;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function handleEndStreamFrame(payload: Uint8Array) {
  if (!payload.length) return;
  const text = decodeUtf8(payload).trim();
  if (!text || text === "{}") return;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (isRecord(parsed) && isRecord(parsed.error)) {
      const message = typeof parsed.error.message === "string" ? parsed.error.message : "Cursor local SDK stream failed";
      throw new HttpError(message, 502, "cursor_stream_error");
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
  }
}

function decodeProtobufFields(bytes: Uint8Array): ProtobufField[] {
  const fields: ProtobufField[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const key = readVarint(bytes, offset);
    offset = key.offset;
    const fieldNumber = key.value >> 3;
    const wireType = key.value & 7;
    if (wireType === 0) {
      const value = readVarint(bytes, offset);
      offset = value.offset;
      fields.push({ no: fieldNumber, wt: wireType, value: value.value });
    } else if (wireType === 2) {
      const length = readVarint(bytes, offset);
      offset = length.offset;
      const end = offset + length.value;
      if (end > bytes.length) break;
      fields.push({ no: fieldNumber, wt: wireType, value: bytes.slice(offset, end) });
      offset = end;
    } else {
      break;
    }
  }
  return fields;
}

function readVarint(bytes: Uint8Array, offset: number): { value: number; offset: number } {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  while (cursor < bytes.length) {
    const byte = bytes[cursor++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, offset: cursor };
    shift += 7;
  }
  return { value, offset: cursor };
}

function bytesField(fields: ProtobufField[], fieldNumber: number): Uint8Array | undefined {
  const field = fields.find((item) => item.no === fieldNumber && item.value instanceof Uint8Array);
  return field?.value instanceof Uint8Array ? field.value : undefined;
}

function stringField(fields: ProtobufField[], fieldNumber: number): string | undefined {
  const bytes = bytesField(fields, fieldNumber);
  return bytes ? decodeUtf8(bytes) : undefined;
}

function stringFields(fields: ProtobufField[], fieldNumber: number): string[] | undefined {
  const values = fields
    .filter((item) => item.no === fieldNumber && item.value instanceof Uint8Array)
    .map((item) => decodeUtf8(item.value as Uint8Array));
  return values.length ? values : undefined;
}

function repeatedMessageFields(fields: ProtobufField[], fieldNumber: number): Uint8Array[] {
  return fields
    .filter((item) => item.no === fieldNumber && item.value instanceof Uint8Array)
    .map((item) => item.value as Uint8Array);
}

function numberField(fields: ProtobufField[], fieldNumber: number): number | undefined {
  const field = fields.find((item) => item.no === fieldNumber && typeof item.value === "number");
  return typeof field?.value === "number" ? field.value : undefined;
}

function booleanField(fields: ProtobufField[], fieldNumber: number): boolean | undefined {
  const value = numberField(fields, fieldNumber);
  return value === undefined ? undefined : value !== 0;
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value ? value : undefined;
}

function compactRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined && (!Array.isArray(value) || value.length > 0))
  );
}

function stableToolCallId(value: Uint8Array): string {
  let hash = 0;
  for (const byte of value.slice(0, 64)) hash = (hash * 31 + byte) >>> 0;
  return `tool_${hash.toString(16)}`;
}

function concatBytes(a: Uint8Array<ArrayBufferLike>, b: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length) as Uint8Array<ArrayBuffer>;
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function dumpProtoFields(payload: Uint8Array, maxDepth: number): string {
  if (maxDepth <= 0 || payload.length === 0) return `[${payload.length}B]`;
  try {
    const fields = decodeProtobufFields(payload);
    if (!fields.length) return `[${payload.length}B empty]`;
    return `{${fields.map((f) => {
      if (f.value instanceof Uint8Array) {
        const str = tryDecodeUtf8Short(f.value);
        if (str !== null) return `${f.no}:str(${str})`;
        return `${f.no}:${dumpProtoFields(f.value, maxDepth - 1)}`;
      }
      return `${f.no}:v(${f.value})`;
    }).join(",")}}`;
  } catch {
    return `[${payload.length}B unparseable]`;
  }
}

function tryDecodeUtf8Short(bytes: Uint8Array): string | null {
  if (bytes.length === 0 || bytes.length > 200) return null;
  for (let i = 0; i < Math.min(bytes.length, 20); i++) {
    if (bytes[i] < 0x20 && bytes[i] !== 0x0a && bytes[i] !== 0x0d && bytes[i] !== 0x09) return null;
  }
  try {
    const s = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return s.length > 100 ? s.slice(0, 100) + "..." : s;
  } catch {
    return null;
  }
}
