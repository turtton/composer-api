import { collectCursorOutput, createCursorCompletion, resolveCursorModel, streamCursorText } from "./cursor";
import { collectCursorSdkOutput, createCursorSdkCompletion } from "./cursor-sdk";
import { bearerToken, errorResponse, json, notFound, optionsResponse, parseJsonBody, sseResponse, unauthorized } from "./http";
import {
  chatChunk,
  chatCompletionResponse,
  chatUsageChunk,
  completionCharsFromOutput,
  doneChunk,
  modelList,
  prepareChatRequest,
  prepareOpencodeSdkChatRequest,
  toOpenAiToolCalls
} from "./openai";
import { encodeSse } from "./sse";
import type { Deps, Env, RouteContext } from "./types";
import type { CursorTextEvent } from "./cursor";
import type { OpenAiToolSpec } from "./openai";

const SSE_KEEPALIVE = new TextEncoder().encode(": keepalive\n\n");

interface AuthResult {
  cursorApiKey: string;
}

const defaultDeps: Deps = {
  fetch: (input, init) => fetch(input, init),
  now: () => new Date(),
  randomUUID: () => crypto.randomUUID()
};

export async function handleRequest(request: Request, env: Env, ctx: RouteContext, deps: Deps = defaultDeps): Promise<Response> {
  if (request.method === "OPTIONS") return optionsResponse();

  try {
    const route = matchOpencodeRoute(new URL(request.url).pathname);
    if (!route) return notFound();
    return await handleOpencodeRoute(request, env, ctx, deps, route);
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleOpencodeRoute(
  request: Request,
  env: Env,
  ctx: RouteContext,
  deps: Deps,
  route: OpencodeRoute
): Promise<Response> {
  if (route.kind === "models") {
    const auth = authenticate(request);
    if (!auth) return unauthorized();
    if (request.method !== "GET") return notFound();
    return json(modelList({ opencode: route.surface === "opencode" || route.surface === "opencodev2", sdk: route.surface === "opencodev2" }));
  }

  if (request.method !== "POST") return notFound();
  const auth = authenticate(request);
  if (!auth) return unauthorized();

  const body = await parseJsonBody<unknown>(request);
  const requestedModel = typeof (body as { model?: unknown })?.model === "string" ? (body as { model: string }).model : "composer-2.5";
  const cursorModel = resolveCursorModel(requestedModel);

  if (route.surface === "opencodev2" && route.kind === "chat") {
    return handleOpenCodeSdkChatRoute(request, env, ctx, deps, auth, body, cursorModel);
  }

  const prepared = prepareChatRequest(body, cursorModel, { forceAgentMode: route.surface === "opencode" });
  const id = `chatcmpl_${crypto.randomUUID().replaceAll("-", "")}`;
  const created = Math.floor(deps.now().getTime() / 1000);

  const completion = await createCursorCompletion(env, deps, auth.cursorApiKey, {
    prompt: prepared.prompt,
    model: prepared.cursorModel,
    conversationKey: route.surface === "opencode" ? sessionAffinity(request) : undefined
  });

  if (prepared.stream) {
    return streamOpenAiChat(streamCursorText(completion.stream), {
      id,
      created,
      model: prepared.model,
      promptChars: prepared.promptChars,
      includeUsage: prepared.includeUsage,
      tools: prepared.tools
    }, ctx);
  }

  const output = await collectCursorOutput(completion.stream);
  const toolCalls = toOpenAiToolCalls({
    toolCalls: output.toolCalls,
    tools: prepared.tools,
    responseId: id
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

async function handleOpenCodeSdkChatRoute(
  request: Request,
  env: Env,
  ctx: RouteContext,
  deps: Deps,
  auth: AuthResult,
  body: unknown,
  cursorModel: { id: string } | undefined
): Promise<Response> {
  const prepared = prepareOpencodeSdkChatRequest(body, cursorModel);
  const id = `chatcmpl_${crypto.randomUUID().replaceAll("-", "")}`;
  const created = Math.floor(deps.now().getTime() / 1000);

  const completion = await createCursorSdkCompletion(env, deps, auth.cursorApiKey, {
    prompt: prepared.prompt,
    model: prepared.cursorModel,
    sessionKey: sessionAffinity(request)
  });

  if (prepared.stream) {
    return streamOpenAiChat(completion.stream, {
      id,
      created,
      model: prepared.model,
      promptChars: prepared.promptChars,
      includeUsage: prepared.includeUsage,
      tools: prepared.tools
    }, ctx);
  }

  const output = await collectCursorSdkOutput(completion.stream);
  const toolCalls = toOpenAiToolCalls({
    toolCalls: output.toolCalls,
    tools: prepared.tools,
    responseId: id
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

function streamOpenAiChat(
  cursorEvents: AsyncIterable<CursorTextEvent>,
  input: {
    id: string;
    created: number;
    model: string;
    promptChars: number;
    includeUsage: boolean;
    tools: OpenAiToolSpec[];
  },
  ctx: RouteContext
): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const pump = async () => {
    let text = "";
    let toolCallCount = 0;
    let finishReason: "stop" | "tool_calls" = "stop";
    const streamedToolCalls: ReturnType<typeof toOpenAiToolCalls> = [];
    try {
      await writer.write(chatChunk({ id: input.id, created: input.created, model: input.model, role: "assistant" }));

      for await (const event of cursorEvents) {
        if (event.type === "text" && event.text) {
          text += event.text;
          await writer.write(chatChunk({ id: input.id, created: input.created, model: input.model, delta: event.text }));
        }
        if (event.type === "thinking" && event.text) {
          await writer.write(chatChunk({ id: input.id, created: input.created, model: input.model, reasoningContent: event.text }));
        }
        if (event.type === "keepalive") {
          await writer.write(SSE_KEEPALIVE);
        }
        if (event.type === "tool_call") {
          finishReason = "tool_calls";
          const [toolCall] = toOpenAiToolCalls({
            toolCalls: [event.toolCall],
            tools: input.tools,
            responseId: input.id,
            startIndex: toolCallCount
          });
          if (toolCall) streamedToolCalls.push(toolCall);
          if (toolCall) {
            await writer.write(chatChunk({ id: input.id, created: input.created, model: input.model, toolCall: { index: toolCallCount, value: toolCall } }));
          }
          toolCallCount += 1;
        }
        if (event.type === "done") {
          text = event.finalText;
        }
      }

      const completionChars = completionCharsFromOutput(text, streamedToolCalls);
      await writer.write(chatChunk({ id: input.id, created: input.created, model: input.model, finish: true, finishReason }));
      if (input.includeUsage) {
        await writer.write(
          chatUsageChunk({
            id: input.id,
            created: input.created,
            model: input.model,
            promptChars: input.promptChars,
            completionChars
          })
        );
      }
      await writer.write(doneChunk());
    } catch (error) {
      const message = error instanceof Error ? error.message : "Stream failed";
      await writer.write(encodeSse({ error: { message, type: "cursor_error", code: "cursor_stream_error" } }, "error"));
    } finally {
      await writer.close().catch(() => undefined);
    }
  };
  ctx.waitUntil(pump());
  return sseResponse(readable);
}

function sessionAffinity(request: Request): string | undefined {
  return (
    request.headers.get("x-session-affinity") ||
    request.headers.get("x-opencode-session-id") ||
    request.headers.get("x-opencode-session")
  )?.trim() || undefined;
}

function authenticate(request: Request): AuthResult | null {
  const token = bearerToken(request);
  if (!token) return null;
  return { cursorApiKey: token };
}

interface OpencodeRoute {
  kind: "chat" | "models";
  surface: "opencode" | "opencodev2";
}

function matchOpencodeRoute(pathname: string): OpencodeRoute | null {
  const opencodePath = pathname.startsWith("/opencode/v1/") ? pathname.slice("/opencode/v1".length) : "";
  if (opencodePath === "/chat/completions") return { kind: "chat", surface: "opencode" };
  if (opencodePath === "/models") return { kind: "models", surface: "opencode" };

  const opencodeV2Path = pathname.startsWith("/opencodev2/v1/") ? pathname.slice("/opencodev2/v1".length) : "";
  if (opencodeV2Path === "/chat/completions") return { kind: "chat", surface: "opencodev2" };
  if (opencodeV2Path === "/models") return { kind: "models", surface: "opencodev2" };

  return null;
}
