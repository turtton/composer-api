import { describe, expect, it } from "vitest";
import { toOpenAiToolCalls } from "./openai";
import { cursorSdkTestExports } from "./cursor-sdk";

describe("Cursor SDK harness", () => {
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
});

function encodeToolCall(input: { taskToolCall: Uint8Array }): Uint8Array {
  return protoMessage([protoBytesField(19, input.taskToolCall)]);
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
