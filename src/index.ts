import http from "node:http";
import { createCursorSdkCompletion, collectCursorSdkOutput } from "./cursor-sdk";
import { prepareOpencodeSdkChatRequest, chatCompletionResponse, chatChunk, chatUsageChunk, doneChunk, toOpenAiToolCalls, modelList, completionCharsFromOutput, HttpError } from "./openai";
import type { Env, CursorTextEvent } from "./types";

const env: Env = {
  CURSOR_BACKEND_BASE_URL: process.env.CURSOR_BACKEND_BASE_URL || "",
  CURSOR_LOCAL_AGENT_ENDPOINT: process.env.CURSOR_LOCAL_AGENT_ENDPOINT || "",
  CURSOR_SDK_CLIENT_VERSION: process.env.CURSOR_SDK_CLIENT_VERSION,
  PORT: process.env.PORT,
  HOST: process.env.HOST
};

const port = Number(env.PORT) || 3000;
const host = env.HOST || "0.0.0.0";

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, x-session-affinity, x-opencode-session-id, x-opencode-session"
};

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    res.setHeader(key, value);
  }

  let headersSent = false;
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/v1/models" && req.method === "GET") {
      respondJson(res, 200, modelList());
      return;
    }

    if (path === "/v1/chat/completions" && req.method === "POST") {
      const apiKey = extractBearerToken(req);
      if (!apiKey) {
        respondJson(res, 401, errorBody("No API key provided", "invalid_api_key"));
        return;
      }

      const body = await readJsonBody(req);
      const prepared = prepareOpencodeSdkChatRequest(body, undefined);
      const sessionKey = extractSessionKey(req);

      const completion = await createCursorSdkCompletion(env, apiKey, {
        prompt: prepared.prompt,
        model: prepared.cursorModel,
        sessionKey
      });

      const responseId = `chatcmpl-${completion.runId.replace(/^run-/, "")}`;
      const created = Math.floor(Date.now() / 1000);

      if (prepared.stream) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive"
        });
        headersSent = true;

        const abortController = new AbortController();
        req.once("close", () => abortController.abort());
        res.once("close", () => abortController.abort());

        let sentRole = false;
        let totalText = "";
        let toolCallIndex = 0;

        for await (const event of completion.stream) {
          if (abortController.signal.aborted) break;
          if (event.type === "text" && event.text) {
            if (!sentRole) {
              res.write(chatChunk({ id: responseId, created, model: prepared.model, role: "assistant" }));
              sentRole = true;
            }
            totalText += event.text;
            res.write(chatChunk({ id: responseId, created, model: prepared.model, delta: event.text }));
          } else if (event.type === "tool_call") {
            if (!sentRole) {
              res.write(chatChunk({ id: responseId, created, model: prepared.model, role: "assistant" }));
              sentRole = true;
            }
            const toolCalls = toOpenAiToolCalls({
              toolCalls: [event.toolCall],
              tools: prepared.tools,
              responseId,
              startIndex: toolCallIndex
            });
            for (const tc of toolCalls) {
              res.write(chatChunk({ id: responseId, created, model: prepared.model, toolCall: { index: toolCallIndex, value: tc } }));
              toolCallIndex++;
            }
          } else if (event.type === "done") {
            if (!sentRole) {
              res.write(chatChunk({ id: responseId, created, model: prepared.model, role: "assistant" }));
              sentRole = true;
            }
            const finishReason = event.toolCalls.length > 0 ? "tool_calls" : "stop";
            res.write(chatChunk({ id: responseId, created, model: prepared.model, finish: true, finishReason }));

            if (prepared.includeUsage) {
              const allToolCalls = toOpenAiToolCalls({
                toolCalls: event.toolCalls,
                tools: prepared.tools,
                responseId
              });
              const completionChars = completionCharsFromOutput(event.finalText, allToolCalls);
              res.write(chatUsageChunk({ id: responseId, created, model: prepared.model, promptChars: prepared.promptChars, completionChars }));
            }

            res.write(doneChunk());
            break;
          }
        }

        if (!sentRole && !abortController.signal.aborted) {
          res.write(chatChunk({ id: responseId, created, model: prepared.model, role: "assistant" }));
          res.write(chatChunk({ id: responseId, created, model: prepared.model, finish: true, finishReason: "stop" }));
          res.write(doneChunk());
        }

        res.end();
      } else {
        const output = await collectCursorSdkOutput(completion.stream);
        const toolCalls = toOpenAiToolCalls({
          toolCalls: output.toolCalls,
          tools: prepared.tools,
          responseId
        });
        respondJson(res, 200, chatCompletionResponse({
          id: responseId,
          created,
          model: prepared.model,
          text: output.text,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          promptChars: prepared.promptChars
        }));
      }
      return;
    }

    respondJson(res, 404, errorBody("Not found", "not_found"));
  } catch (error) {
    if (headersSent) {
      // SSE already started — cannot switch to JSON error. Just end the stream.
      console.error("[stream-error]", error instanceof Error ? error.message : "Unknown error");
      if (!res.writableEnded) res.end();
      return;
    }
    if (error instanceof HttpError) {
      respondJson(res, error.status, errorBody(error.message, error.code || "invalid_request_error", error.param));
    } else {
      const message = error instanceof Error ? error.message : "Internal server error";
      console.error("[error]", message);
      respondJson(res, 500, errorBody("An internal error occurred", "server_error"));
    }
  }
});

server.listen(port, host, () => {
  console.log(`Cursor SDK proxy listening on http://${host}:${port}`);
  console.log(`  POST /v1/chat/completions`);
  console.log(`  GET  /v1/models`);
});

function extractBearerToken(req: http.IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) return undefined;
  const token = auth.slice(7).trim();
  return token || undefined;
}

function extractSessionKey(req: http.IncomingMessage): string {
  const headers = req.headers;
  return (
    (typeof headers["x-session-affinity"] === "string" && headers["x-session-affinity"]) ||
    (typeof headers["x-opencode-session-id"] === "string" && headers["x-opencode-session-id"]) ||
    (typeof headers["x-opencode-session"] === "string" && headers["x-opencode-session"]) ||
    "default"
  );
}

const MAX_BODY_BYTES = 10 * 1024 * 1024;

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(new HttpError("Request body too large", 413, "invalid_request_error"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(JSON.parse(text));
      } catch {
        reject(new HttpError("Invalid JSON body", 400, "invalid_request_error"));
      }
    });
    req.on("error", reject);
  });
}

function respondJson(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(json);
}

function errorBody(message: string, type: string, param?: string): Record<string, unknown> {
  return {
    error: {
      message,
      type,
      ...(param ? { param } : {}),
      code: null
    }
  };
}
