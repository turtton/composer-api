import { resolveCursorModel } from "../worker/cursor";
import {
  bearerToken,
  errorResponse,
  HttpError,
  json,
  notFound,
  openAiError,
  optionsResponse,
  parseJsonBody,
  sseResponse,
  unauthorized
} from "../worker/http";
import {
  chatChunk,
  chatCompletionResponse,
  chatUsageChunk,
  completionCharsFromOutput,
  doneChunk,
  modelList,
  prepareChatRequest,
  toOpenAiToolCalls
} from "../worker/openai";
import { encodeSse } from "../worker/sse";

const PORT = parseInt(process.env.PORT || "8787", 10);
const BRIDGE_URL = process.env.CURSOR_SDK_BRIDGE_URL || "http://localhost:8792/sdk";
const BRIDGE_TOKEN = process.env.CURSOR_SDK_BRIDGE_TOKEN || "";

interface BridgeInput {
  apiKey: string;
  prompt: string;
  model: string;
  sessionKey: string;
  workingDirectory: string;
  streamEvents: boolean;
  tools: unknown[];
}

async function callSdkBridge(input: BridgeInput): Promise<{
  text: string;
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
  agentID: string;
  runID: string;
  status: string;
}> {
  const response = await fetch(BRIDGE_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(BRIDGE_TOKEN ? { authorization: `Bearer ${BRIDGE_TOKEN}` } : {})
    },
    body: JSON.stringify(input)
  });

  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    throw new HttpError(
      error.error?.message || `SDK bridge error: ${response.status}`,
      response.status,
      "cursor_sdk_error"
    );
  }

  return response.json() as Promise<{
    text: string;
    toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
    agentID: string;
    runID: string;
    status: string;
  }>;
}

function streamChatCompletion(
  prepared: ReturnType<typeof prepareChatRequest>,
  apiKey: string,
  sessionKey: string,
  id: string,
  created: number
): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  const pump = async () => {
    let text = "";
    let toolCallCount = 0;
    let finishReason: "stop" | "tool_calls" = "stop";
    const streamedToolCalls: ReturnType<typeof toOpenAiToolCalls> = [];

    try {
      await writer.write(chatChunk({ id, created, model: prepared.model, role: "assistant" }));

      const response = await fetch(BRIDGE_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(BRIDGE_TOKEN ? { authorization: `Bearer ${BRIDGE_TOKEN}` } : {})
        },
        body: JSON.stringify({
          apiKey,
          prompt: prepared.prompt.text,
          model: prepared.cursorModel?.id || prepared.model,
          sessionKey,
          workingDirectory: prepared.toolContext?.workingDirectory || "/workspace",
          streamEvents: true,
          tools: prepared.tools
        } as BridgeInput)
      });

      if (!response.ok || !response.body) {
        throw new HttpError(
          `SDK bridge error: ${response.status}`,
          response.status,
          "cursor_sdk_error"
        );
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const event = JSON.parse(trimmed) as {
            type: string;
            text?: string;
            toolCall?: { name: string; arguments: Record<string, unknown> };
            output?: { text: string; toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> };
            error?: { message?: string };
          };

          if (event.type === "text" && event.text) {
            text += event.text;
            await writer.write(
              chatChunk({ id, created, model: prepared.model, delta: event.text })
            );
          } else if (event.type === "tool_call" && event.toolCall) {
            const [toolCall] = toOpenAiToolCalls({
              toolCalls: [event.toolCall],
              tools: prepared.tools,
              responseId: id,
              startIndex: toolCallCount,
              context: prepared.toolContext
            });
            if (toolCall) {
              finishReason = "tool_calls";
              streamedToolCalls.push(toolCall);
              await writer.write(
                chatChunk({
                  id,
                  created,
                  model: prepared.model,
                  toolCall: { index: toolCallCount, value: toolCall }
                })
              );
              toolCallCount += 1;
            }
          } else if (event.type === "done") {
            text = event.output?.text ?? text;
          } else if (event.type === "error") {
            throw new HttpError(
              event.error?.message || "SDK bridge stream error",
              500,
              "cursor_sdk_error"
            );
          }
        }
      }

      const completionChars = completionCharsFromOutput(text, streamedToolCalls);
      await writer.write(
        chatChunk({ id, created, model: prepared.model, finish: true, finishReason })
      );
      if (prepared.includeUsage) {
        await writer.write(
          chatUsageChunk({
            id,
            created,
            model: prepared.model,
            promptChars: prepared.promptChars,
            completionChars
          })
        );
      }
      await writer.write(doneChunk());
    } catch (error) {
      const message = error instanceof Error ? error.message : "Stream failed";
      await writer.write(
        encodeSse({ error: { message, type: "cursor_error", code: "cursor_stream_error" } }, "error")
      );
    } finally {
      await writer.close().catch(() => undefined);
    }
  };

  pump();
  return sseResponse(readable);
}

async function handleChatCompletions(request: Request): Promise<Response> {
  const body = await parseJsonBody<unknown>(request);
  const apiKey = bearerToken(request);
  if (!apiKey) return unauthorized();

  const requestedModel =
    typeof (body as { model?: unknown })?.model === "string"
      ? (body as { model: string }).model
      : "composer-2.5";
  const cursorModel = resolveCursorModel(requestedModel);
  const prepared = prepareChatRequest(body, cursorModel);

  const id = `chatcmpl_${crypto.randomUUID().replaceAll("-", "")}`;
  const created = Math.floor(Date.now() / 1000);
  const sessionKey =
    request.headers.get("x-session-affinity")?.trim() ||
    request.headers.get("x-opencode-session-id")?.trim() ||
    request.headers.get("x-opencode-session")?.trim() ||
    crypto.randomUUID();

  if (prepared.stream) {
    return streamChatCompletion(prepared, apiKey, sessionKey, id, created);
  }

  const output = await callSdkBridge({
    apiKey,
    prompt: prepared.prompt.text,
    model: cursorModel?.id || prepared.model,
    sessionKey,
    workingDirectory: prepared.toolContext?.workingDirectory || "/workspace",
    streamEvents: false,
    tools: prepared.tools
  });

  const toolCalls = toOpenAiToolCalls({
    toolCalls: output.toolCalls,
    tools: prepared.tools,
    responseId: id,
    context: prepared.toolContext
  });

  return json(
    chatCompletionResponse({
      id,
      created,
      model: prepared.model,
      text: output.text,
      toolCalls,
      promptChars: prepared.promptChars,
      metadata: prepared.responseMetadata
    })
  );
}

const server = Bun.serve({
  port: PORT,
  async fetch(request) {
    if (request.method === "OPTIONS") return optionsResponse();

    const url = new URL(request.url);

    try {
      if (url.pathname === "/health" && request.method === "GET") {
        return json({ ok: true });
      }

      if (url.pathname === "/v1/models" && request.method === "GET") {
        return json(modelList());
      }

      if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
        return await handleChatCompletions(request);
      }

      return notFound();
    } catch (error) {
      return errorResponse(error);
    }
  }
});

console.log(`API server listening on http://localhost:${PORT}`);

process.on("SIGINT", () => {
  console.log("Shutting down gracefully...");
  server.stop(true);
});

process.on("SIGTERM", () => {
  console.log("Shutting down gracefully...");
  server.stop(true);
});
