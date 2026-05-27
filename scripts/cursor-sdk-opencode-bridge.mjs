#!/usr/bin/env node
import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import http2 from "node:http2";
import path from "node:path";
import { fileURLToPath } from "node:url";

const encoder = new TextEncoder();
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

loadEnvFile(path.join(repoRoot, ".env"));
loadEnvFile(path.join(process.cwd(), ".env"));

const host = process.env.CURSOR_SDK_BRIDGE_HOST || "127.0.0.1";
const port = parseInteger(process.env.CURSOR_SDK_BRIDGE_PORT, 8792);
const bridgeToken = process.env.CURSOR_SDK_BRIDGE_TOKEN || "";
const defaultBackendBaseUrl = process.env.CURSOR_BACKEND_BASE_URL || "";
const defaultLocalAgentEndpoint = process.env.CURSOR_LOCAL_AGENT_ENDPOINT || "";
const defaultClientVersion = process.env.CURSOR_SDK_CLIENT_VERSION || "sdk-1.0.13";
const maxJsonBytes = parseInteger(process.env.CURSOR_SDK_BRIDGE_MAX_JSON_BYTES, 1024 * 1024);
const requestTimeoutMs = parseInteger(process.env.CURSOR_SDK_BRIDGE_REQUEST_TIMEOUT_MS, 120_000);
const http2SessionIdleMs = parseInteger(process.env.CURSOR_SDK_BRIDGE_HTTP2_IDLE_MS, 5 * 60 * 1000);
const http2SessionPool = new Map();

export function loadLocalEnvFiles() {
  loadEnvFile(path.join(repoRoot, ".env"));
  loadEnvFile(path.join(process.cwd(), ".env"));
}

export function closeBridgeHttp2Clients() {
  closeAllHttp2Clients();
}

export async function handleBridgeHttpRequest(request, response, options = {}) {
  const requestHost = options.host || host;
  const requestPort = options.port || port;
  const url = new URL(request.url || "/", `http://${request.headers.host || `${requestHost}:${requestPort}`}`);

  if (request.method === "GET" && url.pathname === "/health") {
    writeJson(response, { ok: true });
    return;
  }

  if (request.method !== "POST" || url.pathname !== "/sdk") {
    writeJson(response, openAiError(new HttpError("Not found", 404, "not_found")), 404);
    return;
  }

  if (bridgeToken && bearerToken(request) !== bridgeToken) {
    writeJson(response, openAiError(new HttpError("Invalid bridge token", 401, "unauthorized")), 401);
    return;
  }

  const body = await readJsonBody(request);
  const accessToken = typeof body.accessToken === "string" ? body.accessToken : "";
  const requestId = typeof body.requestId === "string" ? body.requestId : crypto.randomUUID();
  const backendBaseUrl = typeof body.backendBaseUrl === "string" && body.backendBaseUrl ? body.backendBaseUrl : defaultBackendBaseUrl;
  const localAgentEndpoint =
    typeof body.localAgentEndpoint === "string" && body.localAgentEndpoint ? body.localAgentEndpoint : defaultLocalAgentEndpoint;
  const clientVersion = typeof body.clientVersion === "string" && body.clientVersion ? body.clientVersion : defaultClientVersion;
  const runFrame = typeof body.runFrame === "string" ? Buffer.from(body.runFrame, "base64") : null;

  if (!accessToken) throw new HttpError("Missing access token", 400, "invalid_request");
  if (!backendBaseUrl) throw new HttpError("Missing backend base URL", 500, "missing_backend_base_url");
  if (!localAgentEndpoint) throw new HttpError("Missing local agent endpoint", 500, "missing_local_agent_endpoint");
  if (!runFrame?.length) throw new HttpError("Missing run frame", 400, "invalid_request");

  await proxySdkRun(response, {
    accessToken,
    requestId,
    backendBaseUrl,
    localAgentEndpoint,
    clientVersion,
    runFrame
  });
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  const server = http.createServer((request, response) => {
    handleBridgeHttpRequest(request, response).catch((error) => {
      if (!response.headersSent) {
        writeJson(response, openAiError(error), statusFromError(error));
        return;
      }
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });

  server.listen(port, host, () => {
    console.log(`Cursor SDK OpenCode bridge listening on http://${host}:${port}/sdk`);
  });

  process.on("SIGINT", () => closeAndExit(server, 0));
  process.on("SIGTERM", () => closeAndExit(server, 0));
}

async function proxySdkRun(response, input) {
  const endpointUrl = resolveEndpointUrl(input.backendBaseUrl, input.localAgentEndpoint);
  const client = getHttp2Client(endpointUrl.origin);
  const parser = new ConnectFrameParser();
  let request;
  let status = 502;
  let contentType = "application/connect+proto";
  let headersSent = false;
  let contextSent = false;

  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const settle = (callback, value) => {
        if (settled) return;
        settled = true;
        request?.setTimeout?.(0);
        callback(value);
      };
      const finish = () => settle(resolve);
      const fail = (error) => settle(reject, error);

      request = client.request({
        ":method": "POST",
        ":path": `${endpointUrl.pathname}${endpointUrl.search}`,
        authorization: `Bearer ${input.accessToken}`,
        "connect-protocol-version": "1",
        "content-type": "application/connect+proto",
        "user-agent": "connect-es/1.6.1",
        "x-cursor-client-type": "sdk",
        "x-cursor-client-version": input.clientVersion,
        "x-ghost-mode": "true",
        "x-original-request-id": input.requestId,
        "x-request-id": input.requestId
      });
      request.setTimeout(requestTimeoutMs, () => {
        fail(new HttpError("Cursor SDK bridge timed out", 504, "cursor_sdk_bridge_timeout"));
        request.close(http2.constants.NGHTTP2_CANCEL);
      });

      request.once("response", (headers) => {
        status = Number(headers[":status"] || 502);
        contentType = typeof headers["content-type"] === "string" ? headers["content-type"] : contentType;
        response.writeHead(status, {
          "Content-Type": contentType,
          "Cache-Control": "no-cache, no-transform"
        });
        headersSent = true;
      });

      request.on("data", (chunk) => {
        if (!headersSent) return;
        if (status !== 200 || !contentType.includes("application/connect+proto")) {
          response.write(chunk);
          return;
        }
        for (const frame of parser.push(chunk)) {
          const requestContext = !contextSent ? decodeRequestContextEvent(frame.payload) : null;
          if (requestContext) {
            contextSent = true;
            request.write(connectFrame(encodeAgentClientRequestContextResult(requestContext)));
            continue;
          }
          const interactionQuery = decodeInteractionQueryEvent(frame.payload);
          if (interactionQuery) {
            request.write(connectFrame(encodeAgentClientInteractionResponseApproved(interactionQuery)));
            continue;
          }
          response.write(frame.raw);
        }
      });

      request.once("end", () => {
        if (headersSent && status === 200 && contentType.includes("application/connect+proto")) {
          for (const frame of parser.flush()) response.write(frame.raw);
        }
        if (!request.writableEnded) request.end();
        response.end();
        finish();
      });

      request.once("error", fail);
      request.once("close", () => {
        if (!settled) fail(new HttpError("Cursor SDK bridge stream closed before completion", 502, "cursor_sdk_bridge_stream_closed"));
      });

      request.write(input.runFrame);
    });
  } catch (error) {
    if (client.closed || client.destroyed) http2SessionPool.delete(endpointUrl.origin);
    if (!headersSent) throw error;
    response.destroy(error instanceof Error ? error : new Error(String(error)));
  }
}

function getHttp2Client(origin) {
  const current = http2SessionPool.get(origin);
  if (current && !current.closed && !current.destroyed) return current;
  if (current) http2SessionPool.delete(origin);

  const client = http2.connect(origin);
  client.setTimeout(http2SessionIdleMs, () => {
    closePooledHttp2Client(origin);
  });
  client.on("error", () => {
    closePooledHttp2Client(origin);
  });
  client.on("goaway", () => {
    closePooledHttp2Client(origin);
  });
  client.on("close", () => {
    if (http2SessionPool.get(origin) === client) http2SessionPool.delete(origin);
  });
  http2SessionPool.set(origin, client);
  return client;
}

function closePooledHttp2Client(origin) {
  const client = http2SessionPool.get(origin);
  if (!client) return;
  http2SessionPool.delete(origin);
  closeHttp2Client(client);
}

function closeHttp2Client(client) {
  if (!client.closed && !client.destroyed) client.close();
}

function closeAllHttp2Clients() {
  for (const client of http2SessionPool.values()) closeHttp2Client(client);
  http2SessionPool.clear();
}

class ConnectFrameParser {
  buffer = Buffer.alloc(0);

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    return this.readAvailable(false);
  }

  flush() {
    return this.readAvailable(true);
  }

  readAvailable(flush) {
    const frames = [];
    while (this.buffer.length >= 5) {
      const length = this.buffer.readUInt32BE(1);
      if (this.buffer.length < 5 + length) break;
      const raw = this.buffer.subarray(0, 5 + length);
      const flags = raw[0];
      const payload = raw.subarray(5);
      frames.push({ flags, payload, raw });
      this.buffer = this.buffer.subarray(5 + length);
    }
    if (flush && this.buffer.length) {
      frames.push({ flags: 0, payload: this.buffer, raw: this.buffer });
      this.buffer = Buffer.alloc(0);
    }
    return frames;
  }
}

function decodeRequestContextEvent(payload) {
  try {
    for (const field of decodeProtobufFields(payload)) {
      if (field.no !== 2 || !(field.value instanceof Uint8Array)) continue;
      const fields = decodeProtobufFields(field.value);
      if (fields.some((item) => item.no === 10 && item.value instanceof Uint8Array)) return { id: numberField(fields, 1) || 0, execId: stringField(fields, 15) };
    }
  } catch {
    return null;
  }
  return null;
}

const INTERACTION_QUERY_FIELDS = { websearch: 2, webfetch: 9 };

function decodeInteractionQueryEvent(payload) {
  try {
    for (const field of decodeProtobufFields(payload)) {
      if (field.no !== 7 || !(field.value instanceof Uint8Array)) continue;
      const fields = decodeProtobufFields(field.value);
      const id = numberField(fields, 1) || 0;
      for (const [kind, fieldNo] of Object.entries(INTERACTION_QUERY_FIELDS)) {
        if (fields.some((item) => item.no === fieldNo && item.value instanceof Uint8Array)) {
          return { id, kind };
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

function encodeAgentClientInteractionResponseApproved(input) {
  const approved = protoMessage([]);
  const responseFieldNo = INTERACTION_QUERY_FIELDS[input.kind];
  const wrapper = protoMessage([protoMessageField(1, approved)]);
  const interactionResponse = protoMessage([
    protoVarintField(1, input.id),
    protoMessageField(responseFieldNo, wrapper)
  ]);
  return protoMessage([protoMessageField(6, interactionResponse)]);
}

function encodeAgentClientRequestContextResult(input) {
  const env = protoMessage([
    protoStringField(1, "SDK OpenCode bridge"),
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
  const execClientMessage = protoMessage([protoVarintField(1, input.id), protoStringField(15, input.execId), protoMessageField(10, result)]);
  return protoMessage([protoMessageField(2, execClientMessage)]);
}

function connectFrame(payload, flags = 0) {
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = flags;
  frame.writeUInt32BE(payload.length, 1);
  Buffer.from(payload).copy(frame, 5);
  return frame;
}

function protoMessage(parts) {
  return Buffer.concat(parts.map((part) => Buffer.from(part)));
}

function protoMessageField(fieldNumber, value) {
  return protoLengthDelimitedField(fieldNumber, value);
}

function protoStringField(fieldNumber, value) {
  if (value === undefined) return Buffer.alloc(0);
  return protoLengthDelimitedField(fieldNumber, encoder.encode(value));
}

function protoLengthDelimitedField(fieldNumber, value) {
  return protoMessage([varint((fieldNumber << 3) | 2), varint(value.length), value]);
}

function protoVarintField(fieldNumber, value) {
  if (value === undefined) return Buffer.alloc(0);
  return protoMessage([varint(fieldNumber << 3), varint(value === true ? 1 : value === false ? 0 : value)]);
}

function varint(value) {
  const bytes = [];
  let current = value >>> 0;
  while (current >= 0x80) {
    bytes.push((current & 0x7f) | 0x80);
    current >>>= 7;
  }
  bytes.push(current);
  return Buffer.from(bytes);
}

function decodeProtobufFields(bytes) {
  const fields = [];
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
      fields.push({ no: fieldNumber, wt: wireType, value: bytes.subarray(offset, end) });
      offset = end;
    } else {
      break;
    }
  }
  return fields;
}

function readVarint(bytes, offset) {
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

function bytesField(fields, fieldNumber) {
  const field = fields.find((item) => item.no === fieldNumber && item.value instanceof Uint8Array);
  return field?.value instanceof Uint8Array ? field.value : undefined;
}

function stringField(fields, fieldNumber) {
  const bytes = bytesField(fields, fieldNumber);
  return bytes ? new TextDecoder().decode(bytes) : undefined;
}

function numberField(fields, fieldNumber) {
  const field = fields.find((item) => item.no === fieldNumber && typeof item.value === "number");
  return typeof field?.value === "number" ? field.value : undefined;
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxJsonBytes) throw new HttpError("Request body is too large", 413, "request_too_large");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError("Invalid JSON request body", 400, "invalid_json");
  }
}

function resolveEndpointUrl(backendBaseUrl, localAgentEndpoint) {
  return /^https?:\/\//.test(localAgentEndpoint)
    ? new URL(localAgentEndpoint)
    : new URL(localAgentEndpoint.startsWith("/") ? localAgentEndpoint : `/${localAgentEndpoint}`, backendBaseUrl);
}

function bearerToken(request) {
  const authorization = request.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1]?.trim() || "";
}

function writeJson(response, payload, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}

function openAiError(error) {
  const normalized = normalizeError(error);
  return {
    error: {
      message: normalized.message,
      type: "cursor_sdk_bridge_error",
      code: normalized.code || "cursor_sdk_bridge_error"
    }
  };
}

function normalizeError(error) {
  if (error instanceof HttpError) return { message: error.message, code: error.code };
  if (error instanceof Error) return { message: error.message };
  return { message: String(error) };
}

function statusFromError(error) {
  return error instanceof HttpError ? error.status : 500;
}

class HttpError extends Error {
  constructor(message, status = 500, code = "error") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function parseInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function loadEnvFile(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}

function closeAndExit(server, code) {
  closeAllHttp2Clients();
  server.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 2000).unref();
}
