import crypto from "node:crypto";
import http2 from "node:http2";
import { PassThrough } from "node:stream";
import { exchangeCursorApiKey } from "./cursor-auth";
import {
  decodeLocalAgentServerFrame,
  encodeAgentClientRequestContextResult,
  encodeAgentClientRunRequest,
  encodeConnectFrame,
  isEmittableSdkToolCall,
  parseConnectProtoFrames
} from "./proto";
import type { CursorCollectedOutput, CursorImage, CursorSdkCompletion, CursorSdkSession, CursorTextEvent, CursorToolCall, Env } from "./types";

const sdkSessions = new Map<string, CursorSdkSession>();
const http2SessionPool = new Map<string, http2.ClientHttp2Session>();

const SDK_SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_SDK_CLIENT_VERSION = "sdk-1.0.13";
const SDK_STREAM_START_TIMEOUT_MS = 25_000;
const HTTP2_SESSION_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const SDK_REQUEST_TIMEOUT_MS = 120_000;

export async function createCursorSdkCompletion(
  env: Env,
  apiKey: string,
  input: { prompt: { text: string; images?: CursorImage[] }; model?: { id: string }; sessionKey?: string }
): Promise<CursorSdkCompletion> {
  const accessToken = await exchangeCursorApiKey(env, apiKey);
  const now = Date.now();
  pruneSessions(now);
  const sessionIdentity = await sdkSessionIdentity(apiKey, input.sessionKey || "default");
  const session = sdkSessions.get(sessionIdentity);
  const agentId = session?.agentId || newLocalSdkAgentId(crypto.randomUUID());
  const runId = newLocalSdkRunId(crypto.randomUUID());

  sdkSessions.set(sessionIdentity, { agentId, updatedAt: now });

  return {
    agentId,
    runId,
    stream: streamCursorLocalSdkRun(env, accessToken, {
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

async function* streamCursorLocalSdkRun(
  env: Env,
  accessToken: string,
  input: { agentId: string; runId: string; prompt: string; modelId: string }
): AsyncGenerator<CursorTextEvent> {
  let text = "";
  const toolCalls: CursorToolCall[] = [];
  const emittedToolCallIds = new Set<string>();
  const requestId = crypto.randomUUID();
  const endpointUrl = resolveEndpointUrl(env);
  const client = getHttp2Client(endpointUrl.origin);
  const request = client.request({
    ":method": "POST",
    ":path": `${endpointUrl.pathname}${endpointUrl.search}`,
    authorization: `Bearer ${accessToken}`,
    "connect-protocol-version": "1",
    "content-type": "application/connect+proto",
    "user-agent": "connect-es/1.6.1",
    "x-cursor-client-type": "sdk",
    "x-cursor-client-version": env.CURSOR_SDK_CLIENT_VERSION || DEFAULT_SDK_CLIENT_VERSION,
    "x-ghost-mode": "true",
    "x-original-request-id": requestId,
    "x-request-id": requestId
  });
  const responseBody = new PassThrough();
  let responseHeadersReceived = false;
  let responseStatus = 0;
  let contextSent = false;
  let completed = false;
  const errorChunks: Buffer[] = [];
  let errorChunkBytes = 0;
  const MAX_ERROR_BODY = 64 * 1024;

  const startPromise = new Promise<void>((resolve, reject) => {
    const fail = (error: unknown) => reject(error instanceof Error ? error : new Error(String(error)));
    request.setTimeout(SDK_REQUEST_TIMEOUT_MS, () => {
      request.close(http2.constants.NGHTTP2_CANCEL);
      fail(new Error("Cursor local SDK request timed out"));
    });
    request.once("response", (headers) => {
      responseHeadersReceived = true;
      responseStatus = Number(headers[":status"] || 0);
      const contentType = typeof headers["content-type"] === "string" ? headers["content-type"] : "";
      if (responseStatus !== 200) return;
      if (contentType && !contentType.includes("application/connect+proto")) {
        request.close(http2.constants.NGHTTP2_CANCEL);
        reject(new Error(`Cursor local SDK returned unsupported content type: ${contentType}`));
        return;
      }
      resolve();
    });
    request.once("error", (error) => {
      responseBody.destroy(error instanceof Error ? error : new Error(String(error)));
      fail(error);
    });
    request.once("end", () => {
      if (responseHeadersReceived && responseStatus !== 200) {
        const text = Buffer.concat(errorChunks).toString("utf8").trim();
        reject(new Error(responseStatus === 401 ? "Invalid Cursor API key" : text || `Cursor local SDK request failed with status ${responseStatus || "unknown"}`));
      }
    });
    request.once("close", () => {
      if (!completed && responseHeadersReceived && !responseBody.writableEnded) responseBody.destroy(new Error("Cursor local SDK stream closed before completion"));
      if (!completed && !responseHeadersReceived) fail(new Error("Cursor local SDK stream closed before response"));
    });
  });

  request.on("data", (chunk: Buffer) => {
    if (responseHeadersReceived && responseStatus !== 200) {
      if (errorChunkBytes < MAX_ERROR_BODY) {
        errorChunks.push(chunk);
        errorChunkBytes += chunk.length;
      }
    } else {
      responseBody.write(chunk);
    }
  });
  request.once("end", () => responseBody.end());
  request.once("aborted", () => responseBody.destroy(new Error("Cursor local SDK stream was aborted")));

  request.write(
    encodeConnectFrame(
      encodeAgentClientRunRequest({
        agentId: input.agentId,
        messageId: input.runId,
        modelId: input.modelId,
        prompt: input.prompt
      })
    )
  );

  try {
    await withSdkStartTimeout(startPromise);

    for await (const frame of parseConnectProtoFrames(responseBody)) {
      for (const event of decodeLocalAgentServerFrame(frame)) {
        if (event.type === "text" && event.text) {
          text += event.text;
          yield { type: "text", text: event.text };
        } else if (event.type === "tool_call") {
          if (!isEmittableSdkToolCall(event.toolCall)) continue;
          if (!emittedToolCallIds.has(event.id)) {
            emittedToolCallIds.add(event.id);
            toolCalls.push(event.toolCall);
            yield { type: "tool_call", toolCall: event.toolCall };
            yield { type: "done", finalText: text, toolCalls };
            return;
          }
        } else if (event.type === "request_context") {
          if (!contextSent && !request.closed && !request.destroyed) {
            contextSent = true;
            request.write(encodeConnectFrame(encodeAgentClientRequestContextResult(event)));
            request.end();
          }
        } else if (event.type === "done") {
          yield { type: "done", finalText: text, toolCalls };
          return;
        }
      }
    }
  } finally {
    completed = true;
    if (!request.closed && !request.destroyed) request.close(http2.constants.NGHTTP2_CANCEL);
  }

  yield { type: "done", finalText: text, toolCalls };
}

function resolveEndpointUrl(env: Env): URL {
  const base = env.CURSOR_BACKEND_BASE_URL?.trim();
  if (!base) throw new Error("CURSOR_BACKEND_BASE_URL is not configured");
  const endpoint = env.CURSOR_LOCAL_AGENT_ENDPOINT?.trim();
  if (!endpoint) throw new Error("CURSOR_LOCAL_AGENT_ENDPOINT is not configured");
  return /^https?:\/\//.test(endpoint) ? new URL(endpoint) : new URL(endpoint.startsWith("/") ? endpoint : `/${endpoint}`, base);
}

function getHttp2Client(origin: string): http2.ClientHttp2Session {
  const current = http2SessionPool.get(origin);
  if (current && !current.closed && !current.destroyed) return current;
  if (current) http2SessionPool.delete(origin);

  const client = http2.connect(origin);
  client.setTimeout(HTTP2_SESSION_IDLE_TIMEOUT_MS, () => closePooledHttp2Client(origin));
  client.on("error", () => closePooledHttp2Client(origin));
  client.on("goaway", () => closePooledHttp2Client(origin));
  client.on("close", () => {
    if (http2SessionPool.get(origin) === client) http2SessionPool.delete(origin);
  });
  http2SessionPool.set(origin, client);
  return client;
}

function closePooledHttp2Client(origin: string): void {
  const client = http2SessionPool.get(origin);
  if (!client) return;
  http2SessionPool.delete(origin);
  if (!client.closed && !client.destroyed) client.close();
}

function withSdkStartTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Cursor local SDK stream did not start.")), SDK_STREAM_START_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

async function sdkSessionIdentity(apiKey: string, sessionKey: string): Promise<string> {
  const ownerHash = await sha256Hex(`cursor-key:${await sha256Hex(apiKey)}`);
  const sessionHash = await sha256Hex(sessionKey);
  return sha256Hex(`${ownerHash}\n${sessionHash}`);
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Buffer.from(hash).toString("hex");
}

function pruneSessions(now: number): void {
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

function sdkPrompt(prompt: { text: string; images?: CursorImage[] }): string {
  if (!prompt.images?.length) return prompt.text;
  return `${prompt.text}\n\n[${prompt.images.length} image input${prompt.images.length === 1 ? "" : "s"} attached by the OpenAI-compatible client.]`;
}
