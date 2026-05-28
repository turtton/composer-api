import { describe, expect, it, vi } from "vitest";
import { toOpenAiToolCalls } from "./openai";
import { cursorSdkTestExports } from "./cursor-sdk";

describe("Cursor SDK harness", () => {
  it("enables Cursor web search and fetch in SDK request context", () => {
    const encoded = cursorSdkTestExports.encodeAgentClientRequestContextResult({ id: 1, execId: "exec-1" });
    const requestContext = decodeRequestContextFromExecClientMessage(encoded);
    expect(varintField(requestContext, 17)).toBe(1);
    expect(varintField(requestContext, 24)).toBe(1);
    expect(varintField(requestContext, 35)).toBe(1);
  });

  it("times out when the SDK stream goes idle", async () => {
    const stream = new ReadableStream<Uint8Array>();
    const iterator = cursorSdkTestExports.parseConnectProtoFrames(stream, { idleTimeoutMs: 50 });
    await expect(async () => {
      for await (const _frame of iterator) {
        // no frames expected
      }
    }).rejects.toMatchObject({
      status: 504,
      code: "cursor_sdk_stream_idle_timeout"
    });
  });

  it("delimits and prettifies web search results before injecting them as assistant text", () => {
    const chunk = [
      "Links:",
      "1. [Example](https://example.com)",
      "",
      "Highlights:",
      "<result id=\"1\"><title>Example</title><url>https://example.com</url><content>Body line 1\n[...]\nBody line 2</content></result>",
      "<result id=\"2\"><title>Two</title><url>https://two.example.com</url><content>Short body.</content></result>"
    ].join("\n");
    const successPayload = protoMessage([
      protoBytesField(
        1,
        protoMessage([
          protoBytesField(
            1,
            protoMessage([
              protoStringField(1, "Web search results"),
              protoStringField(2, ""),
              protoStringField(3, chunk)
            ])
          )
        ])
      )
    ]);
    const formatted = cursorSdkTestExports.formatHostedSdkToolResult("websearch", { query: "Astro" }, successPayload);
    expect(formatted.startsWith("\n\n")).toBe(true);
    expect(formatted.endsWith("\n\n")).toBe(true);
    expect(formatted).toContain("### 1. Example");
    expect(formatted).toContain("### 2. Two");
    expect(formatted).toContain("https://example.com");
    expect(formatted).not.toMatch(/<\/?result\b/);
    expect(formatted).not.toContain("[...]");
    expect(formatted).toContain("Body line 1\n…\nBody line 2");
  });

  it("preserves <result>-like content that the prettifier cannot parse", () => {
    const chunk = "Highlights:\n<result id=\"99\"><title>Broken</title>";
    const successPayload = protoMessage([
      protoBytesField(
        1,
        protoMessage([
          protoBytesField(
            1,
            protoMessage([
              protoStringField(1, "Web search results"),
              protoStringField(2, ""),
              protoStringField(3, chunk)
            ])
          )
        ])
      )
    ]);
    const formatted = cursorSdkTestExports.formatHostedSdkToolResult("websearch", { query: "broken" }, successPayload);
    expect(formatted).toContain("<result id=\"99\">\n");
  });

  it("truncates very long web search result bodies", () => {
    const longContent = "x".repeat(5000);
    const chunk = `<result id="1"><title>Long</title><url>https://long.example.com</url><content>${longContent}</content></result>`;
    const successPayload = protoMessage([
      protoBytesField(
        1,
        protoMessage([
          protoBytesField(
            1,
            protoMessage([
              protoStringField(1, "Web search results"),
              protoStringField(2, ""),
              protoStringField(3, chunk)
            ])
          )
        ])
      )
    ]);
    const formatted = cursorSdkTestExports.formatHostedSdkToolResult("websearch", { query: "long" }, successPayload);
    expect(formatted).toContain("### 1. Long");
    expect(formatted).toMatch(/…\n\n$/);
    expect(formatted.length).toBeLessThan(2000);
  });

  it("decodes web search interaction queries from the SDK stream", () => {
    const query = protoMessage([
      protoVarintField(1, 42),
      protoBytesField(2, protoMessage([protoBytesField(1, protoMessage([protoStringField(1, "Astro framework")]))]))
    ]);
    const frame = protoMessage([protoBytesField(7, query)]);
    const events = cursorSdkTestExports.decodeLocalAgentServerFrame(frame);
    expect(events).toEqual([{ type: "interaction_query", id: 42, kind: "websearch" }]);
  });

  it("decodes web fetch interaction queries from the SDK stream", () => {
    const query = protoMessage([
      protoVarintField(1, 7),
      protoBytesField(9, protoMessage([protoBytesField(1, protoMessage([protoStringField(1, "https://example.com")]))]))
    ]);
    const frame = protoMessage([protoBytesField(7, query)]);
    const events = cursorSdkTestExports.decodeLocalAgentServerFrame(frame);
    expect(events).toEqual([{ type: "interaction_query", id: 7, kind: "webfetch" }]);
  });

  it("encodes an approved interaction response for websearch", () => {
    const encoded = cursorSdkTestExports.encodeAgentClientInteractionResponseApproved({ id: 9, kind: "websearch" });
    const top = decodeFields(encoded);
    expect(top).toHaveLength(1);
    expect(top[0].no).toBe(6);
    const interactionResponse = decodeFields(top[0].value as Uint8Array);
    expect(interactionResponse.find((field) => field.no === 1)?.value).toBe(9);
    const responseWrapper = interactionResponse.find((field) => field.no === 2);
    expect(responseWrapper?.value).toBeInstanceOf(Uint8Array);
    const approvedField = decodeFields(responseWrapper!.value as Uint8Array).find((field) => field.no === 1);
    expect(approvedField?.value).toBeInstanceOf(Uint8Array);
    expect((approvedField!.value as Uint8Array).length).toBe(0);
  });

  it("encodes an approved interaction response for webfetch on field 9", () => {
    const encoded = cursorSdkTestExports.encodeAgentClientInteractionResponseApproved({ id: 12, kind: "webfetch" });
    const top = decodeFields(encoded);
    const interactionResponse = decodeFields(top[0].value as Uint8Array);
    expect(interactionResponse.find((field) => field.no === 1)?.value).toBe(12);
    expect(interactionResponse.find((field) => field.no === 9)).toBeTruthy();
    expect(interactionResponse.find((field) => field.no === 2)).toBeUndefined();
  });

  it("parses SDK timeout env values", () => {
    expect(cursorSdkTestExports.sdkTimeoutMsFromEnv({}, "CURSOR_SDK_RUN_TIMEOUT_MS", 120_000)).toBe(120_000);
    expect(
      cursorSdkTestExports.sdkTimeoutMsFromEnv({ CURSOR_SDK_RUN_TIMEOUT_MS: "90000" }, "CURSOR_SDK_RUN_TIMEOUT_MS", 120_000)
    ).toBe(90_000);
    expect(
      cursorSdkTestExports.sdkTimeoutMsFromEnv({ CURSOR_SDK_RUN_TIMEOUT_MS: "invalid" }, "CURSOR_SDK_RUN_TIMEOUT_MS", 120_000)
    ).toBe(120_000);
  });

  it("does not emit incomplete SDK tool-call starts to OpenCode", () => {
    expect(cursorSdkTestExports.isEmittableSdkToolCall({ name: "edit", arguments: {} })).toBe(false);
    expect(cursorSdkTestExports.isEmittableSdkToolCall({ name: "write", arguments: { path: "package.json" } })).toBe(false);
    expect(cursorSdkTestExports.isEmittableSdkToolCall({ name: "shell", arguments: {} })).toBe(false);
    expect(cursorSdkTestExports.isEmittableSdkToolCall({ name: "task", arguments: { description: "Explore repo" } })).toBe(false);
  });

  it("allows SDK tool calls once required execution arguments are available", () => {
    expect(cursorSdkTestExports.isEmittableSdkToolCall({ name: "glob", arguments: {} })).toBe(true);
    expect(cursorSdkTestExports.isEmittableSdkToolCall({ name: "write", arguments: { path: "package.json", fileText: "{}" } })).toBe(true);
    expect(cursorSdkTestExports.isEmittableSdkToolCall({ name: "shell", arguments: { command: "npm test" } })).toBe(true);
    expect(
      cursorSdkTestExports.isEmittableSdkToolCall({
        name: "task",
        arguments: {
          description: "Explore auth flow",
          prompt: "Find where login is implemented.",
          subagent_type: "explore"
        }
      })
    ).toBe(true);
  });

  it("converts completed SDK streaming edits into OpenCode writes", () => {
    expect(
      cursorSdkTestExports.normalizeSdkToolCallForOpenCode({
        name: "edit",
        arguments: { path: "scripts/verify.mjs", streamContent: "console.log('ok')\n" }
      })
    ).toEqual({
      name: "write",
      arguments: { path: "scripts/verify.mjs", fileText: "console.log('ok')\n" }
    });
    expect(cursorSdkTestExports.isEmittableSdkToolCall({ name: "edit", arguments: { path: "scripts/verify.mjs", streamContent: "x" } })).toBe(
      true
    );
  });

  it("decodes Cursor task_tool_call protobuf into OpenCode task arguments", () => {
    const decoded = cursorSdkTestExports.decodeSdkToolCall(
      encodeToolCall({
        taskToolCall: encodeTaskToolCall(
          encodeTaskArgs({
            description: "Explore auth flow",
            prompt: "Find where login is implemented.",
            subagentType: encodeSubagentTypeExplore()
          })
        )
      })
    );

    expect(decoded).toEqual({
      hasResult: false,
      toolCall: {
        name: "task",
        arguments: {
          description: "Explore auth flow",
          prompt: "Find where login is implemented.",
          subagent_type: "explore"
        }
      }
    });
  });

  it("maps Cursor custom and unspecified subagent types for OpenCode", () => {
    const custom = cursorSdkTestExports.decodeSdkToolCall(
      encodeToolCall({
        taskToolCall: encodeTaskToolCall(
          encodeTaskArgs({
            description: "Run security audit",
            prompt: "Check auth middleware.",
            subagentType: encodeSubagentTypeCustom("security-audit")
          })
        )
      })
    );
    expect(custom?.toolCall.arguments).toEqual({
      description: "Run security audit",
      prompt: "Check auth middleware.",
      subagent_type: "security-audit"
    });

    const general = cursorSdkTestExports.decodeSdkToolCall(
      encodeToolCall({
        taskToolCall: encodeTaskToolCall(
          encodeTaskArgs({
            description: "Research task",
            prompt: "Summarize findings.",
            subagentType: encodeSubagentTypeUnspecified()
          })
        )
      })
    );
    expect(general?.toolCall.arguments.subagent_type).toBe("general");
  });

  it("forwards decoded task tool calls to OpenAI tool_calls", () => {
    const decoded = cursorSdkTestExports.decodeSdkToolCall(
      encodeToolCall({
        taskToolCall: encodeTaskToolCall(
          encodeTaskArgs({
            description: "Explore repo",
            prompt: "List API routes.",
            subagentType: encodeSubagentTypeExplore()
          })
        )
      })
    );
    expect(decoded).not.toBeNull();
    const normalized = cursorSdkTestExports.normalizeSdkToolCallForOpenCode(decoded!.toolCall);
    expect(cursorSdkTestExports.isEmittableSdkToolCall(normalized)).toBe(true);

    const [toolCall] = toOpenAiToolCalls({
      toolCalls: [normalized],
      tools: [
        {
          name: "task",
          parameters: {
            type: "object",
            properties: {
              description: { type: "string" },
              prompt: { type: "string" },
              subagent_type: { type: "string" }
            },
            required: ["description", "prompt", "subagent_type"]
          }
        }
      ],
      responseId: "resp_task_1"
    });

    expect(toolCall.function.name).toBe("task");
    expect(JSON.parse(toolCall.function.arguments)).toEqual({
      description: "Explore repo",
      prompt: "List API routes.",
      subagent_type: "explore"
    });
  });

  it("decodes Cursor web fetch and search tool calls for OpenCode", () => {
    const webFetch = cursorSdkTestExports.decodeSdkToolCall(
      encodeNamedToolCall(37, encodeWrappedToolArgs(protoMessage([protoStringField(1, "https://example.com/docs")])))
    );
    expect(webFetch?.toolCall).toEqual({ name: "webfetch", arguments: { url: "https://example.com/docs" } });
    expect(cursorSdkTestExports.isCursorHostedSdkToolCall(webFetch!.toolCall)).toBe(true);
    expect(cursorSdkTestExports.isEmittableSdkToolCall(webFetch!.toolCall)).toBe(false);

    const fetch = cursorSdkTestExports.decodeSdkToolCall(
      encodeNamedToolCall(24, encodeWrappedToolArgs(protoMessage([protoStringField(1, "https://example.com/api")])))
    );
    expect(fetch?.toolCall).toEqual({ name: "webfetch", arguments: { url: "https://example.com/api" } });
    expect(cursorSdkTestExports.isEmittableSdkToolCall(fetch!.toolCall)).toBe(false);

    const webSearch = cursorSdkTestExports.decodeSdkToolCall(
      encodeNamedToolCall(18, encodeWrappedToolArgs(protoMessage([protoStringField(1, "opencode task tool")])))
    );
    expect(webSearch?.toolCall).toEqual({ name: "websearch", arguments: { query: "opencode task tool" } });
    expect(cursorSdkTestExports.isCursorHostedSdkToolCall(webSearch!.toolCall)).toBe(true);
    expect(cursorSdkTestExports.isEmittableSdkToolCall(webSearch!.toolCall)).toBe(false);
  });

  it("injects completed Cursor web search results as assistant text", () => {
    const reference = protoMessage([
      protoStringField(1, "OpenCode docs"),
      protoStringField(2, "https://opencode.ai/docs"),
      protoStringField(3, "OpenCode is an open source coding agent.")
    ]);
    const success = protoMessage([protoBytesField(1, reference)]);
    const result = protoMessage([protoBytesField(1, success)]);
    const args = protoMessage([protoStringField(1, "opencode docs")]);
    const inner = protoMessage([protoBytesField(1, args), protoBytesField(2, result)]);
    const toolCall = protoMessage([protoBytesField(18, inner)]);
    const update = protoMessage([protoStringField(1, "call_web_1"), protoBytesField(2, toolCall)]);
    const interaction = protoMessage([protoBytesField(3, update)]);
    const frame = protoMessage([protoBytesField(1, interaction)]);

    const events = cursorSdkTestExports.decodeLocalAgentServerFrame(frame);
    expect(events).toEqual([
      {
        type: "text",
        text:
          "\n\n" +
          [
            'CURSOR WEB SEARCH RESULT (query: "opencode docs"):',
            "- OpenCode docs (https://opencode.ai/docs)",
            "  OpenCode is an open source coding agent."
          ].join("\n") +
          "\n\n"
      }
    ]);
  });

  it("aggregates streaming edit tool-call chunks before emitting the final write", () => {
    const path = "scripts/verify.mjs";
    const partialArgs = protoMessage([protoStringField(1, path), protoStringField(6, "console.log('")]);
    const fullArgs = protoMessage([protoStringField(1, path), protoStringField(6, "console.log('ok')\n")]);
    const partialToolCall = protoMessage([protoBytesField(12, protoMessage([protoBytesField(1, partialArgs)]))]);
    const fullToolCall = protoMessage([protoBytesField(12, protoMessage([protoBytesField(1, fullArgs)]))]);
    const started = protoMessage([protoStringField(1, "edit_call_1"), protoBytesField(2, partialToolCall)]);
    const completed = protoMessage([protoStringField(1, "edit_call_1"), protoBytesField(2, fullToolCall)]);

    const first = cursorSdkTestExports.decodeToolCallUpdate(started, false);
    const second = cursorSdkTestExports.decodeToolCallUpdate(completed, true);
    expect(first?.type).toBe("tool_call");
    expect(second?.type).toBe("tool_call");
    if (first?.type !== "tool_call" || second?.type !== "tool_call") throw new Error("expected tool_call events");

    const merged = cursorSdkTestExports.mergePendingSdkToolCall(first.toolCall, second.toolCall);
    const normalized = cursorSdkTestExports.normalizeSdkToolCallForOpenCode(merged);
    expect(normalized).toEqual({
      name: "write",
      arguments: { path, fileText: "console.log('ok')\n" }
    });
    expect(cursorSdkTestExports.isEmittableSdkToolCall(normalized)).toBe(true);
    expect(cursorSdkTestExports.isEmittableSdkToolCall(first.toolCall)).toBe(true);
  });

  it("warns and ignores unknown SDK tool field numbers without crashing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const decoded = cursorSdkTestExports.decodeSdkToolCall(
      encodeNamedToolCall(99, encodeWrappedToolArgs(protoMessage([protoStringField(1, "noop")])))
    );
    expect(decoded).toBeNull();
    expect(warn).toHaveBeenCalledWith("[cursor-sdk] unknown tool field number 99");
    warn.mockRestore();
  });

  it("surfaces unsupported SDK tools as assistant guidance text", () => {
    const frame = encodeNamedToolCall(
      22,
      encodeWrappedToolArgs(protoMessage([protoStringField(1, "ignored")]))
    );
    const decoded = cursorSdkTestExports.decodeSdkToolCall(frame);
    expect(decoded?.toolCall.name).toBe("recordGrind");
    expect(cursorSdkTestExports.isEmittableSdkToolCall(decoded!.toolCall)).toBe(false);
    expect(cursorSdkTestExports.formatUnsupportedSdkToolMessage(decoded!.toolCall.name)).toContain("recordGrind");
    expect(cursorSdkTestExports.formatUnsupportedSdkToolMessage(decoded!.toolCall.name)).toContain("not available");
  });

  it("decodes Cursor todo and question tool calls for OpenCode", () => {
    const todos = cursorSdkTestExports.decodeSdkToolCall(
      encodeNamedToolCall(
        9,
        encodeWrappedToolArgs(
          protoMessage([
            protoBytesField(
              1,
              protoMessage([protoStringField(1, "todo-1"), protoStringField(2, "Ship feature"), protoVarintField(3, 2)])
            )
          ])
        )
      )
    );
    expect(todos?.toolCall).toEqual({
      name: "todowrite",
      arguments: {
        todos: [{ content: "Ship feature", status: "in_progress", priority: "medium" }]
      }
    });

    const question = cursorSdkTestExports.decodeSdkToolCall(
      encodeNamedToolCall(
        23,
        encodeWrappedToolArgs(
          protoMessage([
            protoBytesField(
              2,
              protoMessage([
                protoStringField(1, "db-choice"),
                protoStringField(2, "Which database should we use?"),
                protoBytesField(3, protoMessage([protoStringField(1, "postgres"), protoStringField(2, "PostgreSQL")])),
                protoVarintField(4, 0)
              ])
            )
          ])
        )
      )
    );
    expect(question?.toolCall).toEqual({
      name: "question",
      arguments: {
        questions: [
          {
            question: "Which database should we use?",
            header: "db-choice",
            options: [{ label: "PostgreSQL", description: "PostgreSQL" }]
          }
        ]
      }
    });
    expect(cursorSdkTestExports.isEmittableSdkToolCall(question!.toolCall)).toBe(true);
  });
});

function decodeRequestContextFromExecClientMessage(encoded: Uint8Array): Array<{ no: number; wt: number; value: unknown }> {
  const execClient = decodeProtobufFields(encoded).find((field) => field.no === 2)?.value;
  if (!(execClient instanceof Uint8Array)) throw new Error("missing exec client message");
  const result = decodeProtobufFields(execClient).find((field) => field.no === 10)?.value;
  if (!(result instanceof Uint8Array)) throw new Error("missing exec result");
  const success = decodeProtobufFields(result).find((field) => field.no === 1)?.value;
  if (!(success instanceof Uint8Array)) throw new Error("missing success");
  const requestContext = decodeProtobufFields(success).find((field) => field.no === 1)?.value;
  if (!(requestContext instanceof Uint8Array)) throw new Error("missing request context");
  return decodeProtobufFields(requestContext);
}

function varintField(fields: Array<{ no: number; wt: number; value: unknown }>, fieldNumber: number): number | undefined {
  const field = fields.find((item) => item.no === fieldNumber);
  return typeof field?.value === "number" ? field.value : undefined;
}

function decodeFields(bytes: Uint8Array): Array<{ no: number; wt: number; value: unknown }> {
  return decodeProtobufFields(bytes);
}

function decodeProtobufFields(bytes: Uint8Array): Array<{ no: number; wt: number; value: unknown }> {
  const fields: Array<{ no: number; wt: number; value: unknown }> = [];
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
      const value = bytes.subarray(offset, offset + length.value);
      offset += length.value;
      fields.push({ no: fieldNumber, wt: wireType, value });
    } else {
      break;
    }
  }
  return fields;
}

function readVarint(bytes: Uint8Array, offset: number): { value: number; offset: number } {
  let value = 0;
  let shift = 0;
  while (offset < bytes.length) {
    const byte = bytes[offset++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return { value, offset };
}

function encodeNamedToolCall(fieldNumber: number, toolCall: Uint8Array): Uint8Array {
  return protoMessage([protoBytesField(fieldNumber, toolCall)]);
}

function encodeWrappedToolArgs(args: Uint8Array): Uint8Array {
  return protoMessage([protoBytesField(1, args)]);
}

function encodeToolCall(input: { taskToolCall: Uint8Array }): Uint8Array {
  return encodeNamedToolCall(19, input.taskToolCall);
}

function encodeTaskToolCall(args: Uint8Array): Uint8Array {
  return protoMessage([protoBytesField(1, args)]);
}

function encodeTaskArgs(input: { description: string; prompt: string; subagentType: Uint8Array }): Uint8Array {
  return protoMessage([
    protoStringField(1, input.description),
    protoStringField(2, input.prompt),
    protoBytesField(3, input.subagentType)
  ]);
}

function encodeSubagentTypeExplore(): Uint8Array {
  return protoMessage([protoBytesField(4, new Uint8Array(0))]);
}

function encodeSubagentTypeUnspecified(): Uint8Array {
  return protoMessage([protoBytesField(1, new Uint8Array(0))]);
}

function encodeSubagentTypeCustom(name: string): Uint8Array {
  return protoMessage([protoBytesField(3, protoMessage([protoStringField(1, name)]))]);
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

function protoStringField(fieldNumber: number, value: string): Uint8Array {
  return protoBytesField(fieldNumber, new TextEncoder().encode(value));
}

function protoBytesField(fieldNumber: number, value: Uint8Array): Uint8Array {
  return protoMessage([varint((fieldNumber << 3) | 2), varint(value.length), value]);
}

function protoVarintField(fieldNumber: number, value: number): Uint8Array {
  return protoMessage([varint(fieldNumber << 3), varint(value)]);
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
