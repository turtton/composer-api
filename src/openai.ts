import { encodeSse } from "./sse";
import type { CursorImage, CursorToolCall, OpenAiToolCall, OpenAiToolSpec, PreparedRequest } from "./types";

type Buffer = Uint8Array;

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly param?: string;
  constructor(message: string, status = 400, code = "invalid_request_error", param?: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.param = param;
  }
}

interface CursorModelPricing {
  input: number;
  output: number;
  source: string;
}

const CURSOR_COMPOSER_2_5_PRICING_SOURCE = "https://cursor.com/changelog/composer-2-5";
const CURSOR_MODEL_PRICING: Record<string, CursorModelPricing> = {
  default: { input: 0.5, output: 2.5, source: CURSOR_COMPOSER_2_5_PRICING_SOURCE },
  auto: { input: 0.5, output: 2.5, source: CURSOR_COMPOSER_2_5_PRICING_SOURCE },
  "composer-latest": { input: 0.5, output: 2.5, source: CURSOR_COMPOSER_2_5_PRICING_SOURCE },
  "composer-2.5": { input: 0.5, output: 2.5, source: CURSOR_COMPOSER_2_5_PRICING_SOURCE },
  "composer-2.5-sdk": { input: 0.5, output: 2.5, source: CURSOR_COMPOSER_2_5_PRICING_SOURCE },
  "composer-2-5": { input: 0.5, output: 2.5, source: CURSOR_COMPOSER_2_5_PRICING_SOURCE },
  "composer-2.5-fast": { input: 3, output: 15, source: CURSOR_COMPOSER_2_5_PRICING_SOURCE },
  "composer-2-5-fast": { input: 3, output: 15, source: CURSOR_COMPOSER_2_5_PRICING_SOURCE }
};

export function prepareOpencodeSdkChatRequest(body: unknown, cursorModel: { id: string } | undefined): PreparedRequest {
  const record = expectRecord(body, "body");
  const messages = expectArray(record.messages, "messages");
  validateCommonUnsupported(record);
  if (record.functions !== undefined) {
    throw new HttpError("Legacy function calling is not supported by this adapter.", 400, "unsupported_parameter", "functions");
  }

  const tools = record.tool_choice === "none" ? [] : parseChatTools(record.tools);
  const model = typeof record.model === "string" && record.model.trim() ? record.model.trim() : "composer-2.5";
  const workspaceMutationRequired = tools.length > 0 && hasWorkspaceMutationIntent(messages);
  const workspaceMutationDone = workspaceMutationRequired && hasWorkspaceMutationToolCall(messages);
  const transcript: string[] = [
    "You are running through an SDK-compatible OpenCode harness.",
    "OpenCode owns local tool execution. When local inspection, shell commands, or file changes are needed, request a tool call and wait for the tool result.",
    "When the conversation includes LOCAL OPENCODE TOOL RESULT records, treat them as completed SDK tool_call results for your previous tool requests and continue from those results.",
    "For creating new files, request write calls with both path and fileText. Do not use edit for new files or emit edit calls without complete replacement details.",
    "For scaffolding a project, prefer shell with a complete command that creates files using heredocs, installs dependencies, and runs tests; shell requires the command argument.",
    "When starting a dev server or other long-running watcher, start it in the background with output redirected and return immediately; do not request a foreground server command.",
    "Do not say that agent mode or tools are unavailable. Do not ask the user to switch modes."
  ];
  appendSdkToolInventory(transcript, tools, record.tool_choice);
  appendSdkWorkspaceMutationRequirement(transcript, workspaceMutationRequired, workspaceMutationDone);
  transcript.push("", "Conversation:");

  const images: CursorImage[] = [];
  const toolCallById = new Map<string, { name: string; args: Record<string, unknown> }>();
  for (const message of messages) {
    const item = expectRecord(message, "messages[]");
    const role = typeof item.role === "string" ? item.role : "user";
    const { text, images: messageImages } = contentToTextAndImages(item.content, role);
    images.push(...messageImages);
    if (role === "tool") {
      const toolCallId = typeof item.tool_call_id === "string" ? item.tool_call_id : "";
      const toolName = typeof item.name === "string" ? item.name : "";
      const label = [toolName ? `name=${toolName}` : "", toolCallId ? `tool_call_id=${toolCallId}` : ""].filter(Boolean).join(" ");
      transcript.push(`TOOL RESULT${label ? ` (${label})` : ""}: ${text || "[empty]"}`);
      transcript.push(`LOCAL OPENCODE TOOL RESULT: ${JSON.stringify(sdkToolResultFeedback(toolCallId, toolName, text, toolCallById))}`);
    } else {
      transcript.push(`${role.toUpperCase()}: ${text || "[empty]"}`);
    }
    if (Array.isArray(item.tool_calls)) {
      transcript.push(`${role.toUpperCase()} TOOL_CALLS: ${JSON.stringify(item.tool_calls)}`);
      rememberOpenCodeToolCalls(item.tool_calls, toolCallById);
    }
  }
  appendChatOptions(transcript, record);
  const text = transcript.join("\n");
  return {
    model,
    cursorModel,
    prompt: { text, mode: "agent", ...(images.length ? { images } : {}) },
    stream: record.stream === true,
    includeUsage: includeStreamUsage(record),
    promptChars: text.length,
    responseMetadata: {
      temperature: numberOrNull(record.temperature),
      top_p: numberOrNull(record.top_p)
    },
    tools
  };
}

export function chatCompletionResponse(input: {
  id: string;
  created: number;
  model: string;
  text: string;
  toolCalls?: OpenAiToolCall[];
  promptChars: number;
  metadata?: Record<string, unknown>;
}): Record<string, unknown> {
  const toolCalls = input.toolCalls ?? [];
  const completionChars = completionCharsFromOutput(input.text, toolCalls);
  return {
    id: input.id,
    object: "chat.completion",
    created: input.created,
    model: input.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: toolCalls.length && !input.text ? null : input.text,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          refusal: null,
          annotations: []
        },
        logprobs: null,
        finish_reason: toolCalls.length ? "tool_calls" : "stop"
      }
    ],
    usage: usageFromChars(input.model, input.promptChars, completionChars),
    service_tier: "default",
    system_fingerprint: null,
    ...input.metadata
  };
}

export function chatChunk(input: {
  id: string;
  created: number;
  model: string;
  delta?: string;
  role?: "assistant";
  toolCall?: { index: number; value: OpenAiToolCall };
  finish?: boolean;
  finishReason?: "stop" | "tool_calls";
}): Buffer {
  const delta = input.finish
    ? {}
    : {
        ...(input.role ? { role: input.role } : {}),
        ...(input.delta ? { content: input.delta } : {}),
        ...(input.toolCall
          ? {
              tool_calls: [
                {
                  index: input.toolCall.index,
                  id: input.toolCall.value.id,
                  type: input.toolCall.value.type,
                  function: input.toolCall.value.function
                }
              ]
            }
          : {})
      };
  const chunk = {
    id: input.id,
    object: "chat.completion.chunk",
    created: input.created,
    model: input.model,
    system_fingerprint: null,
    choices: [
      {
        index: 0,
        delta,
        logprobs: null,
        finish_reason: input.finish ? input.finishReason || "stop" : null
      }
    ]
  };
  return encodeSse(chunk);
}

export function doneChunk(): Buffer {
  return encodeSse("[DONE]");
}

export function chatUsageChunk(input: {
  id: string;
  created: number;
  model: string;
  promptChars: number;
  completionChars: number;
}): Buffer {
  return encodeSse({
    id: input.id,
    object: "chat.completion.chunk",
    created: input.created,
    model: input.model,
    system_fingerprint: null,
    choices: [],
    usage: usageFromChars(input.model, input.promptChars, input.completionChars)
  });
}

export function modelList(): Record<string, unknown> {
  return {
    object: "list",
    data: [
      modelItem("default", "Auto"),
      modelItem("composer-2.5", "Composer 2.5"),
      modelItem("composer-2.5-sdk", "Composer 2.5 SDK Harness"),
      modelItem("composer-2.5-fast", "Cursor Composer 2.5 Fast"),
      modelItem("composer-2", "Cursor Composer 2"),
      modelItem("composer-latest", "Cursor Composer latest alias"),
      modelItem("gpt-5.3-codex", "Codex 5.3"),
      modelItem("gpt-5.2-codex", "Codex 5.2"),
      modelItem("gpt-5.1-codex-max", "Codex 5.1 Max"),
      modelItem("gpt-5.1-codex-mini", "Codex 5.1 Mini"),
      modelItem("gpt-5.2", "GPT-5.2"),
      modelItem("gpt-5.1", "GPT-5.1"),
      modelItem("gpt-5-mini", "GPT-5 Mini"),
      modelItem("gemini-3.1-pro", "Gemini 3.1 Pro"),
      modelItem("gemini-3.5-flash", "Gemini 3.5 Flash"),
      modelItem("gemini-3-flash", "Gemini 3 Flash"),
      modelItem("gemini-2.5-flash", "Gemini 2.5 Flash"),
      modelItem("grok-build-0.1", "Grok Build 0.1"),
      modelItem("grok-4.3", "Grok 4.3"),
      modelItem("kimi-k2.5", "Kimi K2.5")
    ]
  };
}

export function toOpenAiToolCalls(input: {
  toolCalls: CursorToolCall[];
  tools?: OpenAiToolSpec[];
  responseId: string;
  startIndex?: number;
}): OpenAiToolCall[] {
  return input.toolCalls.map((toolCall, offset) => {
    const index = (input.startIndex ?? 0) + offset;
    const tool = resolveToolSpec(toolCall.name, input.tools ?? []);
    const name = tool?.name ?? toolCall.name;
    const toolArguments = normalizeToolArguments(toolCall.arguments ?? {}, tool);
    return {
      id: `call_${input.responseId.replace(/[^A-Za-z0-9]/g, "").slice(-18)}_${index}`,
      type: "function",
      function: {
        name,
        arguments: JSON.stringify(toolArguments)
      }
    };
  });
}

function modelItem(id: string, name: string) {
  const pricing = pricingForModel(id);
  return {
    id,
    object: "model",
    created: 1779148800,
    owned_by: "cursor",
    name,
    ...(pricing ? { cost: { input: pricing.input, output: pricing.output } } : {})
  };
}

export function completionCharsFromOutput(text: string, toolCalls: OpenAiToolCall[] = []): number {
  return text.length + serializedToolCallLength(toolCalls);
}

function parseChatTools(value: unknown): OpenAiToolSpec[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new HttpError("tools must be an array.", 400, "invalid_request_error", "tools");
  return value.map((tool, index) => {
    const record = expectRecord(tool, `tools[${index}]`);
    if (record.type !== "function") {
      throw new HttpError("Only function tools are supported.", 400, "unsupported_parameter", `tools[${index}].type`);
    }
    const fn = expectRecord(record.function, `tools[${index}].function`);
    if (typeof fn.name !== "string" || !fn.name.trim()) {
      throw new HttpError("Tool function name is required.", 400, "invalid_request_error", `tools[${index}].function.name`);
    }
    return {
      name: fn.name.trim(),
      ...(typeof fn.description === "string" ? { description: fn.description } : {}),
      ...(fn.parameters !== undefined ? { parameters: fn.parameters } : {})
    };
  });
}

function appendSdkToolInventory(transcript: string[], tools: OpenAiToolSpec[], toolChoice: unknown) {
  if (!tools.length) return;
  transcript.push(
    "",
    "OPENCODE TOOL INVENTORY:",
    `Allowed tool names: ${tools.map((tool) => tool.name).join(", ")}`,
    "Use only the client's local tools for filesystem and shell work. Prefer shell/read/write/edit/glob/grep/ls style tool requests when those capabilities are present."
  );
  for (const tool of tools) {
    transcript.push(
      JSON.stringify({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        ...(tool.parameters !== undefined ? { parameters: tool.parameters } : {})
      })
    );
  }
  if (isRecord(toolChoice) && toolChoice.type === "function" && isRecord(toolChoice.function) && typeof toolChoice.function.name === "string") {
    transcript.push(`Use the ${toolChoice.function.name} tool if you call a tool.`);
  } else if (toolChoice === "required") {
    transcript.push("You must call at least one tool.");
  }
}

function appendSdkWorkspaceMutationRequirement(transcript: string[], required: boolean, done: boolean) {
  if (!required) return;
  transcript.push(
    "",
    "SDK WORKSPACE MUTATION REQUIRED:",
    "The user is asking you to create or change project files. You must perform the change with local OpenCode tools.",
    "If the workspace is empty, stop probing after the first empty result and create the project files.",
    "Use either write with path and fileText, or shell with command. Do not use edit for new files.",
    done
      ? "A file-mutating tool call has already been made. Continue from the returned tool results and run verification commands when needed."
      : "No file-mutating tool call has been made yet. Your next tool call must be write or shell with complete arguments, not glob, edit, or prose."
  );
}

function validateCommonUnsupported(record: Record<string, unknown>) {
  if (typeof record.n === "number" && record.n !== 1) {
    throw new HttpError("Only n=1 is supported.", 400, "unsupported_parameter", "n");
  }
  if (record.logprobs === true || record.top_logprobs !== undefined) {
    throw new HttpError("logprobs are not available through Cursor's API.", 400, "unsupported_parameter", "logprobs");
  }
  if (Array.isArray(record.modalities) && record.modalities.some((value) => value !== "text")) {
    throw new HttpError("Only text output is supported.", 400, "unsupported_parameter", "modalities");
  }
  if (record.audio !== undefined) {
    throw new HttpError("Audio output is not supported.", 400, "unsupported_parameter", "audio");
  }
}

function appendChatOptions(transcript: string[], record: Record<string, unknown>) {
  const constraints: string[] = [];
  const maxTokens = integerOrNull(record.max_completion_tokens ?? record.max_tokens);
  if (maxTokens) constraints.push(`Keep the answer within about ${maxTokens} output tokens.`);
  appendStopConstraint(constraints, record.stop);
  appendJsonConstraint(constraints, record.response_format);
  if (constraints.length) transcript.push("", "OUTPUT CONSTRAINTS:", ...constraints.map((item) => `- ${item}`));
}

function appendStopConstraint(constraints: string[], stop: unknown) {
  if (typeof stop === "string") constraints.push(`Do not include text after this stop sequence: ${stop}`);
  else if (Array.isArray(stop) && stop.length) constraints.push(`Stop before any of these sequences: ${stop.join(", ")}`);
}

function appendJsonConstraint(constraints: string[], format: unknown) {
  if (!isRecord(format)) return;
  if (format.type === "json_object") constraints.push("Return a single valid JSON object and no surrounding prose.");
  if (format.type === "json_schema") {
    const schema = isRecord(format.json_schema) ? format.json_schema.schema : format.schema;
    constraints.push(`Return JSON that matches this schema: ${JSON.stringify(schema ?? format)}`);
  }
}

function contentToTextAndImages(content: unknown, role: string): { text: string; images: CursorImage[] } {
  if (typeof content === "string") return { text: content, images: [] };
  if (content === null || content === undefined) return { text: "", images: [] };
  if (!Array.isArray(content)) return { text: JSON.stringify(content), images: [] };

  const parts: string[] = [];
  const images: CursorImage[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (!isRecord(part)) {
      parts.push(JSON.stringify(part));
      continue;
    }
    const type = part.type;
    if ((type === "text" || type === "input_text" || type === "output_text") && typeof part.text === "string") {
      parts.push(part.text);
    } else if (type === "image_url" && isRecord(part.image_url) && typeof part.image_url.url === "string") {
      images.push(imageFromUrl(part.image_url.url, part.image_url));
      parts.push("[image]");
    } else if (type === "input_image" && typeof part.image_url === "string") {
      images.push(imageFromUrl(part.image_url));
      parts.push("[image]");
    } else if (type === "input_image" && isRecord(part.image_url) && typeof part.image_url.url === "string") {
      images.push(imageFromUrl(part.image_url.url, part.image_url));
      parts.push("[image]");
    } else if (type === "tool_result" || type === "function_call_output") {
      parts.push(`${role} ${String(type)}: ${JSON.stringify(part)}`);
    } else {
      parts.push(JSON.stringify(part));
    }
  }
  return { text: parts.join("\n"), images };
}

function hasWorkspaceMutationIntent(messages: unknown[]): boolean {
  const userText = messages
    .map((message) => (isRecord(message) && message.role === "user" ? contentToPlainText(message.content) : ""))
    .join("\n")
    .toLowerCase();
  return /\b(make|create|build|add|write|generate|scaffold|implement|set up|setup)\b/.test(userText);
}

function hasWorkspaceMutationToolCall(messages: unknown[]): boolean {
  for (const message of messages) {
    if (!isRecord(message)) continue;
    if (typeof message.name === "string" && isWorkspaceMutationToolCall(message.name, undefined)) return true;
    if (!Array.isArray(message.tool_calls)) continue;
    for (const toolCall of message.tool_calls) {
      if (!isRecord(toolCall)) continue;
      const fn = isRecord(toolCall.function) ? toolCall.function : undefined;
      if (typeof fn?.name === "string" && isWorkspaceMutationToolCall(fn.name, fn.arguments)) return true;
    }
  }
  return false;
}

function isWorkspaceMutationToolCall(name: string, args: unknown): boolean {
  const normalized = normalizeToolName(name);
  if (["write", "writefile", "edit", "editfile"].includes(normalized)) return true;
  if (!["bash", "shell", "terminal"].includes(normalized)) return false;
  const command = firstStringArg(parseToolCallArguments(args), "command", "cmd", "script");
  return command ? isFileMutatingShellCommand(command) : false;
}

function isFileMutatingShellCommand(command: string): boolean {
  const text = command.toLowerCase();
  if (/(^|[\s;&|])(?:cat|printf|echo)\b[\s\S]*(?:>|>>|<<)/.test(text)) return true;
  if (/(?:^|[\s;&|])(?:tee|touch|cp|mv|rm)\b/.test(text)) return true;
  if (/(?:^|[\s;&|])sed\b[^\n]*(?:\s-i\b|\s-i['"]?\s)/.test(text)) return true;
  if (/(?:^|[\s;&|])perl\b[^\n]*(?:\s-pi\b|\s-pi['"]?\s)/.test(text)) return true;
  if (/(?:^|[\s;&|])(?:npm|pnpm|yarn|bun)\s+(?:init|install|add|create)\b/.test(text)) return true;
  return /(?:>|>>)\s*(?:\.{0,2}\/)?[a-z0-9._/-]+/.test(text);
}

function contentToPlainText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") parts.push(part);
    else if (isRecord(part) && typeof part.text === "string") parts.push(part.text);
  }
  return parts.join("\n");
}

function rememberOpenCodeToolCalls(toolCalls: unknown[], output: Map<string, { name: string; args: Record<string, unknown> }>) {
  for (const toolCall of toolCalls) {
    if (!isRecord(toolCall) || typeof toolCall.id !== "string") continue;
    const fn = isRecord(toolCall.function) ? toolCall.function : undefined;
    if (!fn || typeof fn.name !== "string") continue;
    output.set(toolCall.id, {
      name: fn.name,
      args: parseToolCallArguments(fn.arguments)
    });
  }
}

function parseToolCallArguments(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function sdkToolResultFeedback(
  toolCallId: string,
  fallbackToolName: string,
  resultText: string,
  toolCallById: Map<string, { name: string; args: Record<string, unknown> }>
): Record<string, unknown> {
  const original = toolCallById.get(toolCallId);
  const name = original?.name || fallbackToolName || "unknown";
  const args = original?.args ?? {};
  return {
    type: "tool_call",
    call_id: toolCallId || "unknown",
    name: sdkToolNameForOpenCodeTool(name),
    status: "completed",
    args: openCodeArgsToSdkArgs(name, args),
    result: openCodeToolResultToSdkResult(name, args, resultText)
  };
}

function sdkToolNameForOpenCodeTool(name: string): string {
  const normalized = normalizeToolName(name);
  if (["bash", "shell", "terminal"].includes(normalized)) return "shell";
  if (["list", "ls"].includes(normalized)) return "ls";
  if (["read", "readfile"].includes(normalized)) return "read";
  if (["write", "writefile"].includes(normalized)) return "write";
  if (["edit", "editfile"].includes(normalized)) return "edit";
  if (["glob", "fileglob"].includes(normalized)) return "glob";
  if (["grep", "search"].includes(normalized)) return "grep";
  return name;
}

function openCodeArgsToSdkArgs(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  const normalized = normalizeToolName(toolName);
  if (["bash", "shell", "terminal"].includes(normalized)) {
    return compactRecord({
      command: firstStringArg(args, "command", "cmd", "script"),
      workingDirectory: firstStringArg(args, "cwd", "workingDirectory", "directory", "path"),
      timeout: firstNumberArg(args, "timeout")
    });
  }
  if (["write", "writefile"].includes(normalized)) {
    return compactRecord({
      path: firstStringArg(args, "path", "filePath", "file"),
      fileText: firstStringArg(args, "content", "text", "fileText", "newString")
    });
  }
  if (["read", "readfile", "delete", "edit", "editfile", "ls", "list"].includes(normalized)) {
    return compactRecord({
      path: firstStringArg(args, "path", "filePath", "file", "directory")
    });
  }
  if (["glob", "fileglob"].includes(normalized)) {
    return compactRecord({
      targetDirectory: firstStringArg(args, "path", "directory", "cwd", "targetDirectory"),
      globPattern: firstStringArg(args, "pattern", "glob", "include", "globPattern")
    });
  }
  if (["grep", "search"].includes(normalized)) {
    return compactRecord({
      pattern: firstStringArg(args, "pattern", "query", "search", "regex"),
      path: firstStringArg(args, "path", "directory", "cwd"),
      glob: firstStringArg(args, "glob", "include")
    });
  }
  return args;
}

function openCodeToolResultToSdkResult(toolName: string, args: Record<string, unknown>, resultText: string): Record<string, unknown> {
  const parsed = parseToolResultPayload(resultText);
  const normalized = normalizeToolName(toolName);
  if (["bash", "shell", "terminal"].includes(normalized)) {
    return sdkToolResult(parsed, resultText, {
      exitCode: numberFromParsed(parsed, ["exitCode", "exit_code", "code"]) ?? 0,
      signal: stringFromParsed(parsed, ["signal"]) ?? "",
      stdout: stringFromParsed(parsed, ["stdout", "output", "text"]) ?? resultText,
      stderr: stringFromParsed(parsed, ["stderr", "error"]) ?? "",
      executionTime: numberFromParsed(parsed, ["executionTime", "durationMs", "duration_ms"]) ?? 0
    });
  }
  if (["read", "readfile"].includes(normalized)) {
    const content = stringFromParsed(parsed, ["content", "text", "output"]) ?? resultText;
    return sdkToolResult(parsed, resultText, {
      content,
      totalLines: lineCount(content),
      fileSize: content.length
    });
  }
  if (["write", "writefile"].includes(normalized)) {
    const fileText = firstStringArg(args, "content", "text", "fileText", "newString") || "";
    return sdkToolResult(parsed, resultText, {
      path: firstStringArg(args, "path", "filePath", "file") || "",
      linesCreated: lineCount(fileText),
      fileSize: fileText.length
    });
  }
  if (["edit", "editfile"].includes(normalized)) {
    return sdkToolResult(parsed, resultText, {
      diffString: stringFromParsed(parsed, ["diff", "diffString", "output"]) ?? resultText
    });
  }
  if (["glob", "fileglob"].includes(normalized)) {
    const files = stringsFromParsed(parsed, ["files", "paths"]) ?? resultTextLines(resultText);
    return sdkToolResult(parsed, resultText, {
      files,
      totalFiles: files.length,
      clientTruncated: false,
      ripgrepTruncated: false
    });
  }
  return sdkToolResult(parsed, resultText, {
    text: resultText
  });
}

function parseToolResultPayload(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function isErrorToolResult(parsed: unknown, text: string): boolean {
  if (isRecord(parsed)) {
    if (parsed.isError === true || parsed.error !== undefined) return true;
    const exitCode = numberFromParsed(parsed, ["exitCode", "exit_code", "code"]);
    if (exitCode !== undefined && exitCode !== 0) return true;
  }
  return /^\s*(error|failed|exception)\b/i.test(text);
}

function sdkToolResult(parsed: unknown, resultText: string, value: Record<string, unknown>): Record<string, unknown> {
  if (isErrorToolResult(parsed, resultText)) {
    return { status: "error", error: { message: errorMessageFromToolResult(parsed, resultText) } };
  }
  return { status: "success", value };
}

function errorMessageFromToolResult(parsed: unknown, text: string): string {
  if (isRecord(parsed)) {
    const error = parsed.error;
    if (typeof error === "string") return error;
    if (isRecord(error) && typeof error.message === "string") return error.message;
    if (typeof parsed.message === "string") return parsed.message;
  }
  return text || "Tool failed";
}

function firstStringArg(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function firstNumberArg(args: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function stringFromParsed(value: unknown, keys: string[]): string | undefined {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string") return candidate;
  }
  return undefined;
}

function numberFromParsed(value: unknown, keys: string[]): number | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  return undefined;
}

function stringsFromParsed(value: unknown, keys: string[]): string[] | undefined {
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const candidate = value[key];
    if (Array.isArray(candidate) && candidate.every((item) => typeof item === "string")) return candidate;
  }
  return undefined;
}

function resultTextLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function lineCount(text: string): number {
  if (!text) return 0;
  return text.split(/\r?\n/).length;
}

function compactRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function imageFromUrl(url: string, metadata?: Record<string, unknown>): CursorImage {
  const dimension =
    typeof metadata?.width === "number" &&
    typeof metadata.height === "number" &&
    Number.isFinite(metadata.width) &&
    Number.isFinite(metadata.height)
      ? { width: Math.round(metadata.width), height: Math.round(metadata.height) }
      : undefined;
  const dataUrl = /^data:([^;,]+);base64,(.+)$/i.exec(url);
  if (dataUrl) {
    return { mimeType: dataUrl[1], data: dataUrl[2], ...(dimension ? { dimension } : {}) };
  }
  return { url, ...(dimension ? { dimension } : {}) };
}

function usageFromChars(model: string, promptChars: number, completionChars: number) {
  const promptTokens = estimateTokens(promptChars);
  const completionTokens = estimateTokens(completionChars);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
    completion_tokens_details: {
      reasoning_tokens: 0,
      audio_tokens: 0,
      accepted_prediction_tokens: 0,
      rejected_prediction_tokens: 0
    },
    cost: costFromTokens(model, promptTokens, completionTokens)
  };
}

function costFromTokens(model: string, inputTokens: number, outputTokens: number) {
  const pricing = pricingForModel(model);
  if (!pricing) return null;
  const inputUsd = roundUsd((inputTokens / 1_000_000) * pricing.input);
  const outputUsd = roundUsd((outputTokens / 1_000_000) * pricing.output);
  return {
    currency: "USD",
    estimated: true,
    input_usd: inputUsd,
    output_usd: outputUsd,
    total_usd: roundUsd(inputUsd + outputUsd),
    pricing: {
      input_per_million_tokens_usd: pricing.input,
      output_per_million_tokens_usd: pricing.output,
      source: pricing.source
    }
  };
}

function pricingForModel(model: string): CursorModelPricing | null {
  return CURSOR_MODEL_PRICING[model.trim().toLowerCase()] ?? null;
}

function roundUsd(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000;
}

function serializedToolCallLength(toolCalls: OpenAiToolCall[]): number {
  return toolCalls.reduce((sum, toolCall) => sum + toolCall.function.name.length + toolCall.function.arguments.length, 0);
}

function resolveToolSpec(emittedName: string, tools: OpenAiToolSpec[]): OpenAiToolSpec | undefined {
  const exact = tools.find((tool) => tool.name === emittedName);
  if (exact) return exact;
  const normalized = normalizeToolName(emittedName);
  const match = tools.find((tool) => normalizeToolName(tool.name) === normalized);
  if (match) return match;
  const candidates = toolNameAliases(normalized);
  return tools.find((tool) => candidates.includes(normalizeToolName(tool.name)));
}

function normalizeToolName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeToolArguments(args: Record<string, unknown>, tool: OpenAiToolSpec | undefined): Record<string, unknown> {
  const schema = toolParameterSchema(tool);
  const argsToNormalize = expandToolArguments(args);
  if (!schema.properties.length) return argsToNormalize;

  const normalizedProperties = new Map(schema.properties.map((property) => [normalizeToolName(property), property]));
  const output: Record<string, unknown> = {};
  const priorities = new Map<string, number>();
  for (const [key, value] of Object.entries(argsToNormalize)) {
    const mapped = mapToolArgument(key, schema.properties, normalizedProperties, tool?.name);
    if (!mapped) {
      if (schema.allowAdditionalProperties) output[key] = value;
      continue;
    }
    const previous = priorities.get(mapped.target) ?? -1;
    if (mapped.priority >= previous) {
      output[mapped.target] = value;
      priorities.set(mapped.target, mapped.priority);
    }
  }
  return sanitizeNormalizedToolArguments(applyRequiredToolDefaults(output, schema.required, tool, argsToNormalize), tool, argsToNormalize);
}

function toolParameterSchema(tool: OpenAiToolSpec | undefined): {
  properties: string[];
  required: string[];
  allowAdditionalProperties: boolean;
} {
  const parameters = isRecord(tool?.parameters) ? tool.parameters : undefined;
  const properties = isRecord(parameters?.properties) ? parameters.properties : undefined;
  const required = Array.isArray(parameters?.required) ? parameters.required.filter((item): item is string => typeof item === "string") : [];
  return {
    properties: properties ? Object.keys(properties) : [],
    required,
    allowAdditionalProperties: parameters?.additionalProperties === true || isRecord(parameters?.additionalProperties)
  };
}

function applyRequiredToolDefaults(
  output: Record<string, unknown>,
  required: string[],
  tool: OpenAiToolSpec | undefined,
  originalArgs: Record<string, unknown>
): Record<string, unknown> {
  if (!required.length) return output;
  const normalizedTool = normalizeToolName(tool?.name || "");
  const next = { ...output };
  if (["bash", "shell", "terminal"].includes(normalizedTool)) {
    if (required.includes("description") && typeof next.description !== "string") {
      next.description = shellDescription(next.command);
    }
    if (required.includes("command") && typeof next.command !== "string") {
      next.command = firstStringArg(originalArgs, "command", "cmd", "script") || "";
    }
  } else if (["glob", "fileglob", "filesearch", "findfiles"].includes(normalizedTool)) {
    if (required.includes("pattern") && typeof next.pattern !== "string") {
      next.pattern = firstStringArg(originalArgs, "globPattern", "glob", "include", "pattern") || "*";
    }
  }
  return next;
}

function sanitizeNormalizedToolArguments(
  output: Record<string, unknown>,
  tool: OpenAiToolSpec | undefined,
  originalArgs: Record<string, unknown>
): Record<string, unknown> {
  const normalizedTool = normalizeToolName(tool?.name || "");
  if (!["bash", "shell", "terminal"].includes(normalizedTool)) return output;
  const next = { ...output };
  for (const key of ["workdir", "cwd", "directory", "path"]) {
    if (isSyntheticSdkWorkingDirectory(next[key])) delete next[key];
  }
  const command = typeof next.command === "string" ? next.command : firstStringArg(originalArgs, "command", "cmd", "script");
  if (command && shouldBackgroundShellCommand(command)) {
    next.command = backgroundShellCommand(command);
    if (typeof next.description === "string") {
      next.description = `Starts background process: ${next.description}`;
    }
  }
  return next;
}

function isSyntheticSdkWorkingDirectory(value: unknown): boolean {
  return typeof value === "string" && ["", ".", "/workspace", "workspace"].includes(value.trim());
}

function shellDescription(command: unknown): string {
  if (typeof command !== "string" || !command.trim()) return "Runs shell command";
  const first = command.trim().split(/\s+/).slice(0, 5).join(" ");
  return `Runs ${first}`;
}

function shouldBackgroundShellCommand(command: string): boolean {
  const text = command.trim().toLowerCase();
  if (!text || isAlreadyBackgroundedShellCommand(text)) return false;
  if (/\bpython(?:3(?:\.\d+)?)?\s+-m\s+http\.server\b/.test(text)) return true;
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|serve|preview)\b/.test(text)) return true;
  if (/\b(?:npx|bunx)\s+(?:vite|next|nuxt|astro|webpack-dev-server)\b/.test(text)) return true;
  if (/\b(?:vite|next|nuxt|astro|webpack-dev-server)\b/.test(text) && /\b(?:--host|--port|localhost|127\.0\.0\.1|0\.0\.0\.0)\b/.test(text)) {
    return true;
  }
  return /\b(?:uvicorn|gunicorn|flask\s+run|php\s+-s)\b/.test(text);
}

function isAlreadyBackgroundedShellCommand(command: string): boolean {
  return /(^|[\s;&|])(?:nohup|setsid|tmux|screen)\b/.test(command) || /(^|[^&])&\s*(?:$|[;|])/.test(command) || /\bdisown\b|\$!/.test(command);
}

function backgroundShellCommand(command: string): string {
  const logPath = `/tmp/opencode-background-${hashString(command)}.log`;
  return `nohup sh -lc ${shellQuote(command)} > ${shellQuote(logPath)} 2>&1 & echo "Started background process pid=$! log=${logPath}"`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function expandToolArguments(args: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const normalized = normalizeToolName(key);
    const nested = recordArgumentValue(value);
    if (nested && ["arguments", "args", "input", "parameters", "params"].includes(normalized)) {
      Object.assign(output, expandToolArguments(nested));
      continue;
    }
    if (nested && normalized === "targeting") {
      Object.assign(output, expandToolArguments(nested));
      continue;
    }
    output[key] = value;
  }
  return output;
}

function recordArgumentValue(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== "string" || !value.trim().startsWith("{")) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function mapToolArgument(
  key: string,
  properties: string[],
  normalizedProperties: Map<string, string>,
  toolName: string | undefined
): { target: string; priority: number } | null {
  const exact = properties.includes(key) ? key : normalizedProperties.get(normalizeToolName(key));
  if (exact) return { target: exact, priority: 100 };
  return aliasToolArgument(key, properties, normalizedProperties, toolName);
}

function aliasToolArgument(
  key: string,
  properties: string[],
  normalizedProperties: Map<string, string>,
  toolName: string | undefined
): { target: string; priority: number } | null {
  const normalized = normalizeToolName(key);
  const rules = [...toolSpecificArgumentAliases(normalizeToolName(toolName || ""), normalized), ...commonArgumentAliases(normalized)];
  for (const rule of rules) {
    const target = firstMatchingProperty(rule.candidates, properties, normalizedProperties);
    if (target) return { target, priority: rule.priority };
  }
  return null;
}

function firstMatchingProperty(
  candidates: string[],
  properties: string[],
  normalizedProperties: Map<string, string>
): string | undefined {
  for (const candidate of candidates) {
    if (properties.includes(candidate)) return candidate;
    const normalized = normalizedProperties.get(normalizeToolName(candidate));
    if (normalized) return normalized;
  }
  return undefined;
}

function commonArgumentAliases(normalized: string): Array<{ candidates: string[]; priority: number }> {
  const aliases: Record<string, Array<{ candidates: string[]; priority: number }>> = {
    absolutepath: [{ candidates: ["filePath", "path", "file", "filename"], priority: 80 }],
    commandline: [{ candidates: ["command", "cmd", "script"], priority: 80 }],
    contents: [{ candidates: ["content", "newString", "text"], priority: 70 }],
    cwd: [{ candidates: ["cwd", "directory", "path", "pattern"], priority: 45 }],
    directory: [{ candidates: ["directory", "cwd", "path", "pattern"], priority: 45 }],
    filetext: [{ candidates: ["content", "text", "newString"], priority: 95 }],
    filepath: [{ candidates: ["filePath", "path", "file", "filename"], priority: 90 }],
    filename: [{ candidates: ["filePath", "path", "file", "filename"], priority: 75 }],
    glob: [{ candidates: ["pattern", "glob", "include"], priority: 85 }],
    globpattern: [{ candidates: ["pattern", "glob", "include"], priority: 95 }],
    include: [{ candidates: ["include", "pattern", "glob"], priority: 70 }],
    newcontents: [{ candidates: ["content", "newString", "replacement", "text"], priority: 85 }],
    newstring: [{ candidates: ["newString", "replacement", "content"], priority: 95 }],
    newtext: [{ candidates: ["newString", "replacement", "content", "text"], priority: 85 }],
    oldcontents: [{ candidates: ["oldString", "old", "search", "text"], priority: 80 }],
    oldstring: [{ candidates: ["oldString", "old", "search"], priority: 95 }],
    oldtext: [{ candidates: ["oldString", "old", "search", "text"], priority: 85 }],
    pattern: [{ candidates: ["pattern", "query", "regex", "search"], priority: 80 }],
    query: [{ candidates: ["query", "pattern", "search", "prompt"], priority: 80 }],
    regex: [{ candidates: ["pattern", "regex", "query"], priority: 75 }],
    replacement: [{ candidates: ["newString", "replacement", "content"], priority: 85 }],
    script: [{ candidates: ["command", "script", "cmd"], priority: 75 }],
    search: [{ candidates: ["pattern", "query", "oldString", "search"], priority: 70 }],
    searchstring: [{ candidates: ["pattern", "query", "oldString", "search"], priority: 80 }],
    targetdirectory: [{ candidates: ["directory", "cwd", "path", "pattern"], priority: 55 }],
    targetfile: [{ candidates: ["filePath", "path", "file", "filename"], priority: 90 }],
    targeting: [{ candidates: ["path", "directory", "cwd", "pattern", "filePath"], priority: 45 }],
    url: [{ candidates: ["url", "uri", "href"], priority: 90 }]
  };
  if (normalized === "workingdirectory") return [{ candidates: ["workdir", "cwd", "directory", "path"], priority: 90 }];
  if (normalized === "cmd") return [{ candidates: ["command", "cmd", "script"], priority: 95 }];
  if (normalized === "path") return [{ candidates: ["filePath", "path", "directory", "cwd", "pattern"], priority: 75 }];
  if (normalized === "prompt") return [{ candidates: ["prompt", "description", "instructions", "query"], priority: 80 }];
  if (normalized === "tasks") return [{ candidates: ["todos", "tasks", "items"], priority: 75 }];
  if (normalized === "todo" || normalized === "items") return [{ candidates: ["todos", "items", "tasks"], priority: 70 }];
  return aliases[normalized] ?? [];
}

function toolSpecificArgumentAliases(tool: string, normalized: string): Array<{ candidates: string[]; priority: number }> {
  if (["glob", "fileglob", "filesearch", "findfiles"].includes(tool)) {
    if (["globpattern", "glob", "include", "pattern"].includes(normalized)) {
      return [{ candidates: ["pattern", "glob", "include"], priority: 98 }];
    }
    if (["targeting", "targetdirectory", "cwd", "directory", "path"].includes(normalized)) {
      return [{ candidates: ["pattern", "path", "directory", "cwd"], priority: 40 }];
    }
  }
  if (["grep", "search", "searchfiles"].includes(tool)) {
    if (["query", "search", "searchstring", "regex", "pattern"].includes(normalized)) {
      return [{ candidates: ["pattern", "query", "regex", "search"], priority: 95 }];
    }
    if (["globpattern", "glob", "include"].includes(normalized)) {
      return [{ candidates: ["include", "glob", "files", "pattern"], priority: 75 }];
    }
  }
  if (["read", "readfile", "openfile"].includes(tool)) {
    if (["targeting", "targetfile", "filepath", "absolutepath", "path", "file"].includes(normalized)) {
      return [{ candidates: ["filePath", "path", "file", "filename"], priority: 95 }];
    }
  }
  if (["write", "writefile", "createfile"].includes(tool)) {
    if (["targeting", "targetfile", "filepath", "absolutepath", "path", "file"].includes(normalized)) {
      return [{ candidates: ["filePath", "path", "file", "filename"], priority: 95 }];
    }
    if (["newcontents", "contents", "content", "text"].includes(normalized)) {
      return [{ candidates: ["content", "text", "newString"], priority: 95 }];
    }
  }
  if (["edit", "editfile", "replacefile", "searchreplace"].includes(tool)) {
    if (["targeting", "targetfile", "filepath", "absolutepath", "path", "file"].includes(normalized)) {
      return [{ candidates: ["filePath", "path", "file", "filename"], priority: 95 }];
    }
    if (["oldstring", "oldtext", "oldcontents", "search", "searchstring"].includes(normalized)) {
      return [{ candidates: ["oldString", "old", "search"], priority: 95 }];
    }
    if (["newstring", "newtext", "newcontents", "replacement", "replace", "content"].includes(normalized)) {
      return [{ candidates: ["newString", "replacement", "content"], priority: 95 }];
    }
  }
  if (["bash", "shell", "terminal", "runterminalcmd"].includes(tool)) {
    if (["cmd", "commandline", "command", "script"].includes(normalized)) {
      return [{ candidates: ["command", "cmd", "script"], priority: 95 }];
    }
    if (["workingdirectory", "cwd", "directory", "path", "workdir"].includes(normalized)) {
      return [{ candidates: ["workdir", "cwd", "directory", "path"], priority: 95 }];
    }
  }
  if (["webfetch", "fetch", "web"].includes(tool)) {
    if (["url", "uri", "href"].includes(normalized)) return [{ candidates: ["url", "uri", "href"], priority: 95 }];
    if (["prompt", "query", "instructions"].includes(normalized)) {
      return [{ candidates: ["prompt", "query", "instructions"], priority: 90 }];
    }
  }
  if (["todowrite", "todo"].includes(tool) && ["todos", "tasks", "items"].includes(normalized)) {
    return [{ candidates: ["todos", "tasks", "items"], priority: 95 }];
  }
  if (tool === "task") {
    if (["prompt", "instructions", "query"].includes(normalized)) {
      return [{ candidates: ["prompt", "description", "instructions"], priority: 90 }];
    }
    if (["subagenttype", "agent", "agenttype"].includes(normalized)) {
      return [{ candidates: ["subagent_type", "subagentType", "agent"], priority: 90 }];
    }
  }
  return [];
}

function toolNameAliases(normalized: string): string[] {
  const aliases: Record<string, string[]> = {
    createfile: ["write"],
    editfile: ["edit"],
    fileglob: ["glob"],
    filesearch: ["glob", "grep"],
    findfiles: ["glob"],
    openfile: ["read"],
    readfile: ["read"],
    replacefile: ["edit"],
    runterminalcmd: ["bash", "shell"],
    shell: ["bash"],
    searchfiles: ["grep", "glob"],
    searchreplace: ["edit"],
    terminal: ["bash", "shell"],
    ls: ["list"],
    list: ["ls"],
    writefile: ["write"]
  };
  return aliases[normalized] ?? [];
}

function estimateTokens(chars: number): number {
  return Math.max(1, Math.ceil(chars / 4));
}

function includeStreamUsage(record: Record<string, unknown>): boolean {
  return isRecord(record.stream_options) && record.stream_options.include_usage === true;
}

function expectRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new HttpError(`${name} must be an object`, 400, "invalid_request_error", name);
  return value;
}

function expectArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new HttpError(`${name} must be an array`, 400, "invalid_request_error", name);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function integerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
