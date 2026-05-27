import { describe, expect, it } from "vitest";
import { handleRequest } from "./routes";
import { fakeCtx } from "./test-helpers";
import type { Deps, Env } from "./types";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    CURSOR_API_BASE: "https://api.cursor.test",
    CURSOR_BACKEND_BASE_URL: "https://cursor-backend.test",
    CURSOR_CHAT_ENDPOINT: "/test-cursor-chat",
    CURSOR_CLIENT_VERSION: "2.6.22",
    CURSOR_LOCAL_AGENT_ENDPOINT: "/test-local-sdk",
    CURSOR_SDK_CLIENT_VERSION: "sdk-test",
    ...overrides
  };
}

describe("Worker", () => {
  it("allows OpenCode session headers in CORS preflight", async () => {
    const env = makeEnv();
    const { deps } = fakeDeps();

    const response = await handleRequest(new Request("https://composer.test/opencode/v1/chat/completions", { method: "OPTIONS" }), env, fakeCtx(), deps);

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-headers")).toContain("x-session-affinity");
    expect(response.headers.get("access-control-allow-headers")).toContain("x-opencode-session-id");
  });

  it("returns 404 for non-OpenCode routes", async () => {
    const env = makeEnv();
    const { deps } = fakeDeps();

    const response = await handleRequest(
      new Request("https://composer.test/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer cursor_direct_key"
        },
        body: JSON.stringify({ model: "composer-2.5", messages: [{ role: "user", content: "Hi" }] })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(404);
  });

  it("serves OpenCode chat through the SDK harness with tool calls", async () => {
    const env = makeEnv();
    const { deps, chatRequestBodies, sdkRequests } = fakeDeps();

    const response = await handleRequest(
      new Request("https://composer.test/opencodev2/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer cursor_direct_key",
          "x-session-affinity": "session-one"
        },
        body: JSON.stringify({
          model: "composer-2.5",
          stream: true,
          stream_options: { include_usage: true },
          messages: [{ role: "user", content: "List files" }],
          tools: [
            {
              type: "function",
              function: {
                name: "glob",
                parameters: {
                  type: "object",
                  additionalProperties: false,
                  properties: { pattern: { type: "string" } }
                }
              }
            }
          ]
        })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('"object":"chat.completion.chunk"');
    expect(body).toContain('"tool_calls"');
    expect(body).toContain('"name":"glob"');
    expect(body).toContain('"arguments":"{\\"pattern\\":\\"*\\"}"');
    expect(body).toContain('"finish_reason":"tool_calls"');
    expect(body).toContain('"choices":[]');
    expect(body).toContain('"usage"');
    expect(chatRequestBodies).toHaveLength(0);
    expect(sdkRequests.map((item) => `${item.method} ${item.path}`)).toEqual(["POST /test-local-sdk"]);
    expect(String(sdkRequests[0].body)).toContain("agent-");
    expect(String(sdkRequests[0].body)).toContain("SDK-compatible OpenCode harness");
    expect(sdkRequests[0].headers.get("x-cursor-client-type")).toBe("sdk");
    expect(sdkRequests[0].headers.get("x-cursor-client-version")).toBe("sdk-test");
    expect(sdkRequests[0].headers.get("content-type")).toContain("application/connect+proto");
  });

  it("keeps legacy /opencode chat on the Cursor chat endpoint", async () => {
    const env = makeEnv();
    const { deps, chatRequestBodies, sdkRequests } = fakeDeps();

    const response = await handleRequest(
      new Request("https://composer.test/opencode/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer cursor_direct_key_legacy",
          "x-session-affinity": "legacy-session"
        },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [{ role: "user", content: "List files" }],
          tools: [{ type: "function", function: { name: "glob" } }]
        })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      choices: [
        {
          message: {
            content: "Checking the workspace.\n",
            tool_calls: [{ type: "function", function: { name: "glob", arguments: "{\"glob_pattern\":\"*\"}" } }]
          },
          finish_reason: "tool_calls"
        }
      ]
    });
    expect(sdkRequests).toHaveLength(0);
    expect(chatRequestBodies).toHaveLength(1);
    expect(chatRequestBodies[0]).toContain("This request is already in Agent mode");
    expect(chatRequestBodies[0]).toContain("Switched to agent mode successfully.");
    expect(chatRequestBodies[0]).not.toContain("SDK-compatible OpenCode harness");
  });

  it("keeps OpenCode SDK agents stable for a session-affinity header", async () => {
    const env = makeEnv();
    const { deps, chatRequestBodies, sdkRequests } = fakeDeps();

    for (const affinity of ["session-one", "session-one", "session-two"]) {
      const response = await handleRequest(
        new Request("https://composer.test/opencodev2/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer cursor_direct_key_stability",
            "x-session-affinity": affinity
          },
          body: JSON.stringify({
            model: "composer-2.5",
            messages: [{ role: "user", content: "Say hello" }]
          })
        }),
        env,
        fakeCtx(),
        deps
      );
      expect(response.status).toBe(200);
      await response.json();
    }

    expect(chatRequestBodies).toHaveLength(0);
    const paths = sdkRequests.map((item) => `${item.method} ${item.path}`);
    expect(paths).toEqual(["POST /test-local-sdk", "POST /test-local-sdk", "POST /test-local-sdk"]);
    const firstAgent = /agent-[0-9a-f-]{36}/.exec(String(sdkRequests[0].body))?.[0];
    expect(firstAgent).toBeTruthy();
    expect(String(sdkRequests[1].body)).toContain(firstAgent!);
    expect(String(sdkRequests[2].body)).not.toContain(firstAgent!);
    expect(String(sdkRequests[0].body)).toContain("SDK-compatible OpenCode harness");
    expect(String(sdkRequests[0].body)).not.toContain("Switched to agent mode successfully");
  });

  it("streams local SDK output from one run", async () => {
    const env = makeEnv();
    const { deps, sdkRequests } = fakeDeps();

    const response = await handleRequest(
      new Request("https://composer.test/opencodev2/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer cursor_direct_key_retry",
          "x-session-affinity": "retry-session"
        },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [{ role: "user", content: "Retry dropped stream" }]
        })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      choices: [{ message: { content: "Partial after retry" }, finish_reason: "stop" }]
    });
    expect(sdkRequests.map((item) => `${item.method} ${item.path}`)).toEqual(["POST /test-local-sdk"]);
  });

  it("can route OpenCode SDK runs through a standard streaming bridge", async () => {
    const env = makeEnv({ CURSOR_SDK_BRIDGE_URL: "https://bridge.test/sdk" });
    const { deps, sdkRequests } = fakeDeps();

    const response = await handleRequest(
      new Request("https://composer.test/opencodev2/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer cursor_direct_key_bridge",
          "x-session-affinity": "bridge-session"
        },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [{ role: "user", content: "Say hello" }]
        })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      choices: [{ message: { content: "Hello from SDK" }, finish_reason: "stop" }]
    });
    expect(sdkRequests.map((item) => `${item.method} ${item.path}`)).toEqual(["POST /sdk"]);
    expect(sdkRequests[0].headers.get("content-type")).toContain("application/json");
    expect(String(sdkRequests[0].body)).toContain("SDK-compatible OpenCode harness");
  });

  it("reuses the SDK agent id for the same OpenCode session", async () => {
    const env = makeEnv();
    const firstDeps = fakeDeps();

    const first = await handleRequest(
      new Request("https://composer.test/opencodev2/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer cursor_direct_key_persisted",
          "x-session-affinity": "persisted-session"
        },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [{ role: "user", content: "Say hello" }]
        })
      }),
      env,
      fakeCtx(),
      firstDeps.deps
    );
    expect(first.status).toBe(200);
    await first.json();

    const secondDeps = fakeDeps();
    const second = await handleRequest(
      new Request("https://composer.test/opencodev2/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer cursor_direct_key_persisted",
          "x-session-affinity": "persisted-session"
        },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [{ role: "user", content: "Say hello again" }]
        })
      }),
      env,
      fakeCtx(),
      secondDeps.deps
    );

    expect(second.status).toBe(200);
    await second.json();
    expect(secondDeps.sdkRequests.map((item) => `${item.method} ${item.path}`)).toEqual(["POST /test-local-sdk"]);
    const agentMatch = /agent-[0-9a-f-]+/i.exec(String(firstDeps.sdkRequests[0].body));
    expect(agentMatch).toBeTruthy();
    expect(String(secondDeps.sdkRequests[0].body)).toContain(agentMatch![0]);
  });

  it("feeds OpenCode tool results back to the SDK run as SDK-shaped tool output", async () => {
    const env = makeEnv();
    const { deps, sdkRequests } = fakeDeps();

    const response = await handleRequest(
      new Request("https://composer.test/opencodev2/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer cursor_direct_key_tool_result",
          "x-session-affinity": "tool-result-session"
        },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [
            { role: "user", content: "Run tests" },
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_shell_1",
                  type: "function",
                  function: { name: "bash", arguments: "{\"command\":\"npm test\"}" }
                }
              ]
            },
            {
              role: "tool",
              tool_call_id: "call_shell_1",
              name: "bash",
              content: "{\"exitCode\":0,\"stdout\":\"tests passed\",\"stderr\":\"\",\"executionTime\":123}"
            }
          ]
        })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      choices: [{ message: { content: "Tool result incorporated" }, finish_reason: "stop" }]
    });
    const prompt = String(sdkRequests[0].body);
    expect(prompt).toContain("LOCAL OPENCODE TOOL RESULT");
    expect(prompt).toContain("\"name\":\"shell\"");
    expect(prompt).toContain("\"status\":\"completed\"");
    expect(prompt).toContain("\"stdout\":\"tests passed\"");
  });

  it("maps SDK shell calls to OpenCode bash schema including required defaults", async () => {
    const env = makeEnv();
    const { deps } = fakeDeps();

    const response = await handleRequest(
      new Request("https://composer.test/opencodev2/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer cursor_direct_key_shell",
          "x-session-affinity": "shell-session"
        },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [{ role: "user", content: "Run shell command" }],
          tools: [
            {
              type: "function",
              function: {
                name: "bash",
                parameters: {
                  type: "object",
                  properties: {
                    command: { type: "string" },
                    workdir: { type: "string" },
                    description: { type: "string" }
                  },
                  required: ["command", "description"]
                }
              }
            }
          ]
        })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { choices: Array<{ message: { tool_calls: Array<{ function: { arguments: string } }> } }> };
    const args = JSON.parse(body.choices[0].message.tool_calls[0].function.arguments) as Record<string, unknown>;
    expect(args).toEqual({
      command: "npm test",
      description: "Runs npm test"
    });
  });

  it("does not return completed SDK tool-result updates as fresh OpenCode tool calls", async () => {
    const env = makeEnv();
    const { deps, chatRequestBodies, sdkRequests } = fakeDeps();

    const response = await handleRequest(
      new Request("https://composer.test/opencodev2/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer cursor_direct_key_completed_tool",
          "x-session-affinity": "completed-tool"
        },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [{ role: "user", content: "Completed SDK tool result" }],
          tools: [
            {
              type: "function",
              function: {
                name: "read",
                parameters: {
                  type: "object",
                  properties: { filePath: { type: "string" } }
                }
              }
            }
          ]
        })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { choices: Array<{ message: { content: string; tool_calls?: unknown[] }; finish_reason: string }> };
    expect(body.choices[0].message.content).toBe("Done after cloud result");
    expect(body.choices[0].message.tool_calls).toBeUndefined();
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(chatRequestBodies).toHaveLength(0);
    expect(sdkRequests.map((item) => `${item.method} ${item.path}`)).toEqual(["POST /test-local-sdk"]);
  });

  it("labels OpenCode model lists for legacy and SDK routes", async () => {
    const env = makeEnv();
    const { deps } = fakeDeps();

    const opencodeLegacy = await handleRequest(
      new Request("https://composer.test/opencode/v1/models", {
        headers: { Authorization: "Bearer cursor_direct_key" }
      }),
      env,
      fakeCtx(),
      deps
    );
    const opencodeSdk = await handleRequest(
      new Request("https://composer.test/opencodev2/v1/models", {
        headers: { Authorization: "Bearer cursor_direct_key" }
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(opencodeLegacy.status).toBe(200);
    expect(opencodeSdk.status).toBe(200);
    const opencodeLegacyBody = (await opencodeLegacy.json()) as { data: Array<{ id: string; name: string; cost?: { input: number; output: number } }> };
    const opencodeSdkBody = (await opencodeSdk.json()) as { data: Array<{ id: string; name: string; cost?: { input: number; output: number } }> };
    expect(opencodeLegacyBody.data.find((model) => model.id === "composer-2.5")?.name).toBe("Composer 2.5");
    expect(opencodeLegacyBody.data.map((model) => model.id)).not.toContain("composer-2.5-sdk");
    expect(opencodeSdkBody.data.find((model) => model.id === "composer-2.5")?.name).toBe("Composer 2.5");
    expect(opencodeSdkBody.data.find((model) => model.id === "composer-2.5-sdk")?.name).toBe("Composer 2.5 SDK Harness");
    expect(opencodeSdkBody.data.find((model) => model.id === "composer-2.5")?.cost).toEqual({ input: 0.5, output: 2.5 });
  });

  it("requires a bearer token for OpenCode models", async () => {
    const env = makeEnv();
    const { deps } = fakeDeps();

    const noAuth = await handleRequest(new Request("https://composer.test/opencodev2/v1/models"), env, fakeCtx(), deps);
    expect(noAuth.status).toBe(401);

    const withAuth = await handleRequest(
      new Request("https://composer.test/opencodev2/v1/models", {
        headers: { Authorization: "Bearer cursor_direct_key" }
      }),
      env,
      fakeCtx(),
      deps
    );
    expect(withAuth.status).toBe(200);
  });
});

function fakeDeps(): {
  deps: Deps;
  exchangeAuthHeaders: string[];
  chatAuthHeaders: string[];
  chatRequestHeaders: Headers[];
  chatRequestBodies: string[];
  sdkRequests: Array<{ method: string; path: string; headers: Headers; body: unknown }>;
} {
  const exchangeAuthHeaders: string[] = [];
  const chatAuthHeaders: string[] = [];
  const chatRequestHeaders: Headers[] = [];
  const chatRequestBodies: string[] = [];
  const sdkRequests: Array<{ method: string; path: string; headers: Headers; body: unknown }> = [];
  let uuidCounter = 0;
  const deps: Deps = {
    now: () => new Date("2026-05-20T12:00:00.000Z"),
    randomUUID: () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, "0")}`,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const auth = new Headers(init?.headers).get("authorization") || "";
      if (url.pathname === "/v1/me") {
        return Response.json({
          apiKeyName: "Test key",
          userId: 123,
          userEmail: "ada@example.com",
          userFirstName: "Ada",
          userLastName: "Lovelace",
          createdAt: "2026-05-20T00:00:00.000Z"
        });
      }
      if (url.pathname === "/auth/exchange_user_api_key" && init?.method === "POST") {
        exchangeAuthHeaders.push(auth);
        return Response.json({ accessToken: "cursor_access_token" });
      }
      if (url.pathname === "/test-local-sdk" && init?.method === "POST") {
        const headers = new Headers(init.headers);
        const body = await decodeRequestBody(init.body);
        sdkRequests.push({ method: "POST", path: url.pathname, headers, body });
        return localSdkFakeResponse(sdkRunKind(body));
      }
      if (url.hostname === "bridge.test" && url.pathname === "/sdk" && init?.method === "POST") {
        const headers = new Headers(init.headers);
        const payload = JSON.parse(String(init.body || "{}")) as { runFrame?: string };
        const body = payload.runFrame ? decodeBase64ForTest(payload.runFrame) : "";
        sdkRequests.push({ method: "POST", path: url.pathname, headers, body });
        return localSdkFakeResponse(sdkRunKind(body));
      }
      if (url.pathname === "/test-cursor-chat" && init?.method === "POST") {
        const headers = new Headers(init.headers);
        chatAuthHeaders.push(auth);
        chatRequestHeaders.push(headers);
        expect(headers.get("content-type")).toContain("application/connect+proto");
        const requestText = await decodeRequestBody(init.body);
        chatRequestBodies.push(requestText);
        if (requestText.includes("List files")) {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  connectFrame(
                    chatResponseText(
                      [
                        "Checking the workspace.\n",
                        "<|tool_calls_begin|><|tool_call_begin|>\n",
                        "Glob\n",
                        "<|tool_sep|>glob_pattern\n",
                        "*\n",
                        "<|tool_call_end|><|tool_calls_end|>"
                      ].join("")
                    )
                  )
                );
                controller.enqueue(connectFrame(new TextEncoder().encode("{}"), 2));
                controller.close();
              }
            }),
            { headers: { "Content-Type": "application/connect+proto" } }
          );
        }
        expect(requestText).toContain("Say hello");
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(connectFrame(chatResponseThinking("The answer is simple.</think>\nHello from Composer")));
              controller.enqueue(connectFrame(new TextEncoder().encode("{}"), 2));
              controller.close();
            }
          }),
          { headers: { "Content-Type": "application/connect+proto" } }
        );
      }
      return new Response("not found", { status: 404 });
    }
  };
  return { deps, exchangeAuthHeaders, chatAuthHeaders, chatRequestHeaders, chatRequestBodies, sdkRequests };
}

async function decodeRequestBody(body: BodyInit | null | undefined): Promise<string> {
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  if (typeof body === "string") return body;
  if (body instanceof ReadableStream) {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
        if (chunks.length >= 1) break;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    return new TextDecoder().decode(concatTestBytes(chunks));
  }
  return "";
}

function sdkRunKind(body: string): "completed" | "drop" | "hello" | "list" | "shell" | "tool-result" {
  const text = body;
  if (text.includes("Completed SDK tool result")) return "completed";
  if (text.includes("LOCAL OPENCODE TOOL RESULT:")) return "tool-result";
  if (text.includes("Retry dropped stream")) return "drop";
  if (text.includes("Run shell command")) return "shell";
  if (text.includes("List files")) return "list";
  return "hello";
}

function localSdkFakeResponse(kind: ReturnType<typeof sdkRunKind>): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (kind === "list") {
          controller.enqueue(localSdkToolCallFrame("sdk_call_1", 4, protoMessage([protoField(2, "*")])));
        } else if (kind === "drop") {
          controller.enqueue(localSdkTextFrame("Partial after retry"));
        } else if (kind === "shell") {
          controller.enqueue(localSdkExecFrame(1, 2, protoMessage([protoField(1, "npm test"), protoField(2, "/workspace")])));
        } else if (kind === "completed") {
          const readArgs = protoMessage([protoField(1, "README.md")]);
          const readCall = protoMessage([protoField(1, readArgs), protoField(2, protoMessage([]))]);
          controller.enqueue(localSdkToolCallCompletedFrame("sdk_call_completed", 8, readCall));
          controller.enqueue(localSdkTextFrame("Done after cloud result"));
        } else if (kind === "tool-result") {
          controller.enqueue(localSdkTextFrame("Tool result incorporated"));
        } else {
          controller.enqueue(localSdkTextFrame("Hello from SDK"));
        }
        controller.enqueue(localSdkTurnEndedFrame());
        controller.enqueue(connectFrame(new TextEncoder().encode("{}"), 2));
        controller.close();
      }
    }),
    { headers: { "Content-Type": "application/connect+proto" } }
  );
}

function decodeBase64ForTest(value: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(value), (char) => char.charCodeAt(0)));
}

function concatTestBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function chatResponseThinking(text: string): Uint8Array {
  return protoMessage([protoField(2, protoMessage([protoField(25, protoMessage([protoField(1, text)]))]))]);
}

function chatResponseText(text: string): Uint8Array {
  return protoMessage([protoField(2, protoMessage([protoField(1, text)]))]);
}

function localSdkTextFrame(text: string): Uint8Array {
  const textDelta = protoMessage([protoField(1, text)]);
  const interaction = protoMessage([protoField(1, textDelta)]);
  return connectFrame(protoMessage([protoField(1, interaction)]));
}

function localSdkTurnEndedFrame(): Uint8Array {
  const interaction = protoMessage([protoField(14, protoMessage([]))]);
  return connectFrame(protoMessage([protoField(1, interaction)]));
}

function localSdkToolCallFrame(callId: string, toolField: number, args: Uint8Array): Uint8Array {
  const toolPayload = protoMessage([protoField(1, args)]);
  const toolCall = protoMessage([protoField(toolField, toolPayload)]);
  const started = protoMessage([protoField(1, callId), protoField(2, toolCall)]);
  const interaction = protoMessage([protoField(2, started)]);
  return connectFrame(protoMessage([protoField(1, interaction)]));
}

function localSdkToolCallCompletedFrame(callId: string, toolField: number, toolCallPayload: Uint8Array): Uint8Array {
  const toolCall = protoMessage([protoField(toolField, toolCallPayload)]);
  const completed = protoMessage([protoField(1, callId), protoField(2, toolCall)]);
  const interaction = protoMessage([protoField(3, completed)]);
  return connectFrame(protoMessage([protoField(1, interaction)]));
}

function localSdkExecFrame(execId: number, execField: number, args: Uint8Array): Uint8Array {
  const exec = protoMessage([protoVarintField(1, execId), protoField(execField, args)]);
  return connectFrame(protoMessage([protoField(2, exec)]));
}

function connectFrame(payload: Uint8Array, flags = 0): Uint8Array {
  const frame = new Uint8Array(5 + payload.length);
  frame[0] = flags;
  new DataView(frame.buffer).setUint32(1, payload.length, false);
  frame.set(payload, 5);
  return frame;
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

function protoField(fieldNumber: number, value: string | Uint8Array): Uint8Array {
  const data = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return protoMessage([varint((fieldNumber << 3) | 2), varint(data.length), data]);
}

function protoVarintField(fieldNumber: number, value: number): Uint8Array {
  return protoMessage([varint(fieldNumber << 3), varint(value)]);
}

function varint(value: number): Uint8Array {
  const bytes: number[] = [];
  let current = value;
  while (current >= 0x80) {
    bytes.push((current & 0x7f) | 0x80);
    current >>>= 7;
  }
  bytes.push(current);
  return new Uint8Array(bytes);
}
