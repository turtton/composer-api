export interface Env {
  CURSOR_BACKEND_BASE_URL: string;
  CURSOR_LOCAL_AGENT_ENDPOINT: string;
  CURSOR_SDK_CLIENT_VERSION?: string;
  PORT?: string;
  HOST?: string;
}

export type CursorImage =
  | { url: string; dimension?: { width: number; height: number } }
  | { data: string; mimeType: string; dimension?: { width: number; height: number } };

export interface CursorPrompt {
  text: string;
  images?: CursorImage[];
  mode?: "ask" | "agent";
}

export interface CursorToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export type CursorTextEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; toolCall: CursorToolCall }
  | { type: "done"; finalText: string; toolCalls: CursorToolCall[] };

export interface CursorCollectedOutput {
  text: string;
  toolCalls: CursorToolCall[];
}

export interface OpenAiToolSpec {
  name: string;
  description?: string;
  parameters?: unknown;
}

export interface OpenAiToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface PreparedRequest {
  model: string;
  cursorModel?: { id: string };
  prompt: CursorPrompt;
  stream: boolean;
  includeUsage: boolean;
  promptChars: number;
  responseMetadata: Record<string, unknown>;
  tools: OpenAiToolSpec[];
}

export interface CursorSdkSession {
  agentId: string;
  updatedAt: number;
}

export interface CursorSdkCompletion {
  agentId: string;
  runId: string;
  stream: AsyncGenerator<CursorTextEvent>;
}
