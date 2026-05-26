import type { Readable } from "node:stream";
import type { CursorToolCall } from "./types";

export interface ProtobufField {
  no: number;
  wt: number;
  value: number | Uint8Array;
}

export type LocalSdkDecodedEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; toolCall: CursorToolCall }
  | { type: "request_context"; id: number; execId?: string }
  | { type: "done" }
  | { type: "ignore" };

export type ArgsKind =
  | "delete"
  | "edit"
  | "glob"
  | "grep"
  | "ls"
  | "mcp"
  | "readExec"
  | "readLints"
  | "readTool"
  | "semSearch"
  | "shell"
  | "write";

export interface ToolSpec {
  name: string;
  argsKind: ArgsKind;
}

export const AGENT_MODE_AGENT = 1;

export const TOOL_CALL_SPECS: Record<number, ToolSpec> = {
  1: { name: "shell", argsKind: "shell" },
  3: { name: "delete", argsKind: "delete" },
  4: { name: "glob", argsKind: "glob" },
  5: { name: "grep", argsKind: "grep" },
  8: { name: "read", argsKind: "readTool" },
  12: { name: "edit", argsKind: "edit" },
  13: { name: "ls", argsKind: "ls" },
  14: { name: "readLints", argsKind: "readLints" },
  15: { name: "mcp", argsKind: "mcp" },
  16: { name: "semSearch", argsKind: "semSearch" }
};

export const EXEC_TOOL_SPECS: Record<number, ToolSpec> = {
  2: { name: "shell", argsKind: "shell" },
  3: { name: "write", argsKind: "write" },
  4: { name: "delete", argsKind: "delete" },
  5: { name: "grep", argsKind: "grep" },
  7: { name: "read", argsKind: "readExec" },
  8: { name: "ls", argsKind: "ls" },
  9: { name: "readLints", argsKind: "readLints" },
  11: { name: "mcp", argsKind: "mcp" },
  14: { name: "shell", argsKind: "shell" }
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function protoMessage(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

export function protoMessageField(fieldNumber: number, value: Uint8Array): Uint8Array {
  return protoLengthDelimitedField(fieldNumber, value);
}

export function protoStringField(fieldNumber: number, value: string | undefined): Uint8Array {
  if (value === undefined) return new Uint8Array(0);
  return protoLengthDelimitedField(fieldNumber, textEncoder.encode(value));
}

export function protoLengthDelimitedField(fieldNumber: number, value: Uint8Array): Uint8Array {
  return protoMessage([varint((fieldNumber << 3) | 2), varint(value.length), value]);
}

export function protoVarintField(fieldNumber: number, value: number | boolean | undefined): Uint8Array {
  if (value === undefined) return new Uint8Array(0);
  return protoMessage([varint(fieldNumber << 3), varint(value === true ? 1 : value === false ? 0 : value)]);
}

export function varint(value: number): Uint8Array {
  const bytes: number[] = [];
  let current = value >>> 0;
  while (current >= 0x80) {
    bytes.push((current & 0x7f) | 0x80);
    current >>>= 7;
  }
  bytes.push(current);
  return new Uint8Array(bytes);
}

export function encodeConnectFrame(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + payload.length);
  frame[0] = 0;
  new DataView(frame.buffer, frame.byteOffset, frame.byteLength).setUint32(1, payload.length, false);
  frame.set(payload, 5);
  return frame;
}

const MAX_FRAME_SIZE = 64 * 1024 * 1024;

export async function* parseConnectProtoFrames(stream: Readable): AsyncGenerator<Uint8Array> {
  let buffer = new Uint8Array(0);
  for await (const chunk of stream) {
    const raw = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
    const bytes = new Uint8Array(raw.length);
    bytes.set(raw);
    buffer = concatBytes(buffer, bytes);
    for (;;) {
      if (buffer.length < 5) break;
      const flags = buffer[0];
      const length = new DataView(buffer.buffer, buffer.byteOffset + 1, 4).getUint32(0, false);
      if (length > MAX_FRAME_SIZE) throw new Error(`Connect frame exceeds maximum size: ${length} bytes`);
      if (buffer.length < 5 + length) break;
      const payload = buffer.slice(5, 5 + length);
      buffer = buffer.slice(5 + length);
      if ((flags & 1) === 1) throw new Error("Cursor returned a compressed SDK frame that this application cannot decode.");
      if ((flags & 2) === 2) {
        handleEndStreamFrame(payload);
        continue;
      }
      yield payload;
    }
  }
  if (buffer.length > 0) {
    throw new Error(`Cursor SDK stream ended with ${buffer.length} unprocessed bytes`);
  }
}

function handleEndStreamFrame(payload: Uint8Array): void {
  if (!payload.length) return;
  const text = decodeUtf8(payload).trim();
  if (!text || text === "{}") return;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (isRecord(parsed) && isRecord(parsed.error)) {
      const message = typeof parsed.error.message === "string" ? parsed.error.message : "Cursor local SDK stream failed";
      throw new Error(message);
    }
  } catch (error) {
    if (error instanceof Error) throw error;
  }
}

export function decodeProtobufFields(bytes: Uint8Array): ProtobufField[] {
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

export function readVarint(bytes: Uint8Array, offset: number): { value: number; offset: number } {
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

export function bytesField(fields: ProtobufField[], fieldNumber: number): Uint8Array | undefined {
  const field = fields.find((item) => item.no === fieldNumber && item.value instanceof Uint8Array);
  return field?.value instanceof Uint8Array ? field.value : undefined;
}

export function stringField(fields: ProtobufField[], fieldNumber: number): string | undefined {
  const bytes = bytesField(fields, fieldNumber);
  return bytes ? decodeUtf8(bytes) : undefined;
}

export function stringFields(fields: ProtobufField[], fieldNumber: number): string[] | undefined {
  const values = fields
    .filter((item) => item.no === fieldNumber && item.value instanceof Uint8Array)
    .map((item) => decodeUtf8(item.value as Uint8Array));
  return values.length ? values : undefined;
}

export function numberField(fields: ProtobufField[], fieldNumber: number): number | undefined {
  const field = fields.find((item) => item.no === fieldNumber && typeof item.value === "number");
  return typeof field?.value === "number" ? field.value : undefined;
}

export function booleanField(fields: ProtobufField[], fieldNumber: number): boolean | undefined {
  const value = numberField(fields, fieldNumber);
  return value === undefined ? undefined : value !== 0;
}

export function encodeAgentClientRunRequest(input: { agentId: string; messageId: string; modelId: string; prompt: string }): Uint8Array {
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

export function encodeAgentClientRequestContextResult(input: { id: number; execId?: string }): Uint8Array {
  const env = protoMessage([
    protoStringField(1, "Docker self-hosted"),
    protoStringField(2, "."),
    protoStringField(3, "sh"),
    protoVarintField(5, false),
    protoStringField(10, "UTC"),
    protoStringField(11, "."),
    protoStringField(21, ".")
  ]);
  const requestContext = protoMessage([
    protoMessageField(4, env),
    protoVarintField(17, false),
    protoVarintField(24, false),
    protoVarintField(32, true),
    protoVarintField(33, true),
    protoVarintField(35, false),
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

export function decodeLocalAgentServerFrame(payload: Uint8Array): LocalSdkDecodedEvent[] {
  const output: LocalSdkDecodedEvent[] = [];
  try {
    for (const field of decodeProtobufFields(payload)) {
      if (field.no === 1 && field.value instanceof Uint8Array) {
        output.push(...decodeInteractionUpdate(field.value));
      } else if (field.no === 2 && field.value instanceof Uint8Array) {
        const event = decodeExecServerMessage(field.value);
        if (event) output.push(event);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not decode Cursor local SDK stream";
    throw new Error(message);
  }
  return output.length ? output : [{ type: "ignore" }];
}

export function decodeInteractionUpdate(payload: Uint8Array): LocalSdkDecodedEvent[] {
  const output: LocalSdkDecodedEvent[] = [];
  for (const field of decodeProtobufFields(payload)) {
    if (!(field.value instanceof Uint8Array)) continue;
    if (field.no === 1) {
      const text = stringField(decodeProtobufFields(field.value), 1);
      if (text) output.push({ type: "text", text });
    } else if (field.no === 2 || field.no === 3 || field.no === 7) {
      const event = decodeToolCallUpdate(field.value, field.no === 3);
      if (event) output.push(event);
    } else if (field.no === 14) {
      output.push({ type: "done" });
    }
  }
  return output;
}

export function decodeToolCallUpdate(payload: Uint8Array, completed: boolean): LocalSdkDecodedEvent | null {
  const fields = decodeProtobufFields(payload);
  const callId = stringField(fields, 1) || stableToolCallId(payload);
  const toolCallBytes = bytesField(fields, 2);
  if (!toolCallBytes) return null;
  const decoded = decodeSdkToolCall(toolCallBytes);
  if (!decoded || (completed && decoded.hasResult)) return null;
  return { type: "tool_call", id: callId, toolCall: normalizeSdkToolCallForOpenCode(decoded.toolCall) };
}

export function decodeSdkToolCall(payload: Uint8Array): { toolCall: CursorToolCall; hasResult: boolean } | null {
  for (const field of decodeProtobufFields(payload)) {
    if (!(field.value instanceof Uint8Array)) continue;
    const spec = TOOL_CALL_SPECS[field.no];
    if (!spec) continue;
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

export function decodeExecServerMessage(payload: Uint8Array): LocalSdkDecodedEvent | null {
  const fields = decodeProtobufFields(payload);
  if (fields.some((field) => field.no === 10 && field.value instanceof Uint8Array)) {
    return {
      type: "request_context",
      id: numberField(fields, 1) || 0,
      execId: stringField(fields, 15)
    };
  }
  return decodeExecServerToolCall(payload, fields);
}

export function decodeExecServerToolCall(payload: Uint8Array, fields = decodeProtobufFields(payload)): LocalSdkDecodedEvent | null {
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
      toolCall: normalizeSdkToolCallForOpenCode({ name: spec.name, arguments: args })
    };
  }
  return null;
}

export function normalizeSdkToolCallForOpenCode(toolCall: CursorToolCall): CursorToolCall {
  if (toolCall.name.toLowerCase() !== "edit") return toolCall;
  const path = stringArg(toolCall.arguments, "path");
  const streamContent = stringArg(toolCall.arguments, "streamContent");
  if (!path || streamContent === undefined) return toolCall;
  return {
    name: "write",
    arguments: { path, fileText: streamContent }
  };
}

export function isEmittableSdkToolCall(toolCall: CursorToolCall): boolean {
  const name = toolCall.name.toLowerCase();
  const args = toolCall.arguments ?? {};
  if (name === "glob") return true;
  if (name === "ls") return true;
  if (name === "shell") return hasStringArg(args, "command");
  if (name === "write") return hasStringArg(args, "path") && hasStringArg(args, "fileText");
  if (name === "edit") {
    return (
      hasStringArg(args, "path") &&
      (hasStringArg(args, "patchContent") || hasStringArg(args, "oldText") || hasStringArg(args, "newText") || hasStringArg(args, "streamContent"))
    );
  }
  if (name === "read" || name === "delete") return hasStringArg(args, "path");
  if (name === "grep") return hasStringArg(args, "pattern");
  if (name === "semSearch") return hasStringArg(args, "query");
  if (name === "readLints") return Array.isArray(args.paths) && args.paths.some((item) => typeof item === "string" && item.trim());
  if (name === "mcp") return hasStringArg(args, "toolName") || hasStringArg(args, "providerIdentifier");
  return Object.keys(args).length > 0;
}

export function decodeToolArgs(kind: ArgsKind, payload: Uint8Array): Record<string, unknown> {
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
      return compactRecord({ path: stringField(fields, 1), offset: numberField(fields, 2), limit: numberField(fields, 3), includeLineNumbers: booleanField(fields, 5) });
    case "readExec":
      return compactRecord({ path: stringField(fields, 1), toolCallId: stringField(fields, 2), offset: numberField(fields, 4), limit: numberField(fields, 5) });
    case "edit":
      return compactRecord({ path: stringField(fields, 1), oldText: stringField(fields, 2), newText: stringField(fields, 3), patchContent: stringField(fields, 4), streamContent: stringField(fields, 6) });
    case "ls":
      return compactRecord({ path: stringField(fields, 1), ignore: stringFields(fields, 2), toolCallId: stringField(fields, 3) });
    case "readLints":
      return compactRecord({ paths: stringFields(fields, 1) });
    case "mcp":
      return compactRecord({ providerIdentifier: stringField(fields, 1), toolName: stringField(fields, 2), toolCallId: stringField(fields, 4) });
    case "semSearch":
      return compactRecord({ query: stringField(fields, 1), targetDirectories: stringFields(fields, 2), explanation: stringField(fields, 3) });
  }
}

export function compactRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && (!Array.isArray(value) || value.length > 0)));
}

export function stableToolCallId(value: Uint8Array): string {
  let hash = 0;
  for (const byte of value.slice(0, 64)) hash = (hash * 31 + byte) >>> 0;
  return `tool_${hash.toString(16)}`;
}

export function concatBytes(a: Uint8Array<ArrayBufferLike>, b: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export function decodeUtf8(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function hasStringArg(args: Record<string, unknown>, key: string): boolean {
  return typeof args[key] === "string" && args[key].trim().length > 0;
}

export function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value ? value : undefined;
}
