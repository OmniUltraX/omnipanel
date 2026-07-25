import { describe, expect, it } from "vitest";
import {
  appendTextLikePart,
  coalescePartsByToolSegments,
  deriveCompatFields,
  partsFromFlatFields,
  stripLeakedToolCallsJson,
  upsertToolCallInParts,
  type AiMessagePart,
} from "../../../lib/ai/aiMessageParts";

describe("AiMessage ordered parts", () => {
  it("migrate flat fields into reasoning → text → tools", () => {
    const parts = partsFromFlatFields({
      content: "answer",
      reasoningContent: "think",
      toolCalls: [
        { id: "t1", name: "run", arguments: "{}", status: "completed", result: "ok" },
      ],
    });
    expect(parts.map((p) => p.type)).toEqual(["reasoning", "text", "tool-call"]);
  });

  it("append switches to a new text segment after a tool call", () => {
    let parts: AiMessagePart[] = [{ type: "reasoning", text: "r1" }];
    parts = appendTextLikePart(parts, "text", "hello");
    parts = upsertToolCallInParts(parts, "c1", "tool_a", "{}");
    parts = appendTextLikePart(parts, "reasoning", "r2");
    parts = appendTextLikePart(parts, "text", "final");
    expect(parts.map((p) => p.type)).toEqual([
      "reasoning",
      "text",
      "tool-call",
      "reasoning",
      "text",
    ]);
    const compat = deriveCompatFields(parts);
    expect(compat.content).toBe("hellofinal");
    expect(compat.reasoningContent).toBe("r1r2");
    expect(compat.toolCalls?.map((t) => t.id)).toEqual(["c1"]);
  });

  it("upsert updates existing tool-call by id without reordering", () => {
    let parts: AiMessagePart[] = [
      { type: "text", text: "a" },
      {
        type: "tool-call",
        id: "c1",
        name: "old",
        arguments: "{}",
        status: "running",
      },
      { type: "text", text: "b" },
    ];
    parts = upsertToolCallInParts(parts, "c1", "new", '{"x":1}');
    expect(parts[1]).toMatchObject({
      type: "tool-call",
      id: "c1",
      name: "new",
      arguments: '{"x":1}',
    });
    expect(parts.map((p) => p.type)).toEqual(["text", "tool-call", "text"]);
  });

  it("coalesce merges interleaved reasoning/text within a tool segment", () => {
    const parts: AiMessagePart[] = [
      { type: "text", text: "好的，我来检查" },
      {
        type: "tool-call",
        id: "c1",
        name: "omni_terminal_run_terminal_command",
        arguments: "{}",
        status: "completed",
      },
      {
        type: "reasoning",
        text: "找到了 mihomo 代理服务正在运行。让我进一步检查它的详细状态和端口监听",
      },
      { type: "text", text: "找到了" },
      { type: "reasoning", text: "情况。" },
      { type: "text", text: "! 服务器运行的是 Mihomo。" },
      {
        type: "tool-call",
        id: "c2",
        name: "omni_terminal_run_terminal_command",
        arguments: "{}",
        status: "running",
      },
    ];
    const coalesced = coalescePartsByToolSegments(parts);
    expect(coalesced.map((p) => p.type)).toEqual([
      "text",
      "tool-call",
      "reasoning",
      "text",
      "tool-call",
    ]);
    expect(coalesced[2]).toMatchObject({
      type: "reasoning",
      text: "找到了 mihomo 代理服务正在运行。让我进一步检查它的详细状态和端口监听情况。",
    });
    expect(coalesced[3]).toMatchObject({
      type: "text",
      text: "找到了! 服务器运行的是 Mihomo。",
    });
  });

  it("stripLeakedToolCallsJson removes embedded tool JSON from text", () => {
    expect(stripLeakedToolCallsJson('{"tool_calls":[{"id":"c1"}]}')).toBe("");
    expect(
      stripLeakedToolCallsJson('先说一句\n{"tool_calls":[{"id":"c1"}]}'),
    ).toBe("先说一句");
    expect(stripLeakedToolCallsJson("正常回答")).toBe("正常回答");
  });
});
