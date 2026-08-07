import { describe, expect, it } from "vitest";
import {
  appendTextLikePart,
  coalescePartsByToolSegments,
  coalescePartsForCoherentDisplay,
  coalesceToolsInThinkingPhases,
  deriveCompatFields,
  joinTextFragments,
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
        name: "omni_ssh_exec",
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
        name: "omni_ssh_exec",
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

  it("同一思考阶段内被 reasoning 隔开的工具合并为连续 tool-call", () => {
    const parts: AiMessagePart[] = [
      { type: "reasoning", text: "r1" },
      {
        type: "tool-call",
        id: "t1",
        name: "bash",
        arguments: "{}",
        status: "completed",
      },
      { type: "reasoning", text: "r2" },
      {
        type: "tool-call",
        id: "t2",
        name: "bash",
        arguments: "{}",
        status: "completed",
      },
      { type: "text", text: "结论" },
      {
        type: "tool-call",
        id: "t3",
        name: "bash",
        arguments: "{}",
        status: "completed",
      },
    ];
    expect(coalesceToolsInThinkingPhases(parts).map((p) => p.type)).toEqual([
      "reasoning",
      "reasoning",
      "tool-call",
      "tool-call",
      "text",
      "tool-call",
    ]);
    expect(
      coalesceToolsInThinkingPhases(parts)
        .filter((p) => p.type === "tool-call")
        .map((p) => (p as Extract<AiMessagePart, { type: "tool-call" }>).id),
    ).toEqual(["t1", "t2", "t3"]);
  });

  it("joinTextFragments 中文直接拼接、英文相邻补空格", () => {
    expect(joinTextFragments("常见", "环境管理器")).toBe("常见环境管理器");
    expect(joinTextFragments("hello", "world")).toBe("hello world");
    expect(joinTextFragments("hello ", "world")).toBe("hello world");
  });

  it("coherent display：reasoning/tool 置顶折叠区，正文合并为一段", () => {
    const parts: AiMessagePart[] = [
      { type: "text", text: "列出系统里各 Python 解释器与常见" },
      { type: "reasoning", text: "先查 which/pyenv" },
      {
        type: "tool-call",
        id: "c1",
        name: "omni_ssh_create_run_script",
        arguments: "{}",
        status: "completed",
      },
      { type: "text", text: "环境管理器状态" },
      { type: "reasoning", text: "再确认 conda" },
      {
        type: "tool-call",
        id: "c2",
        name: "omni_ssh_create_run_script",
        arguments: "{}",
        status: "running",
      },
      { type: "text", text: "。Ubuntu 24.04.2。" },
    ];
    const display = coalescePartsForCoherentDisplay(parts);
    expect(display.map((p) => p.type)).toEqual([
      "reasoning",
      "tool-call",
      "tool-call",
      "text",
    ]);
    expect(display[0]).toMatchObject({
      type: "reasoning",
      text: "先查 which/pyenv再确认 conda",
    });
    expect(display[3]).toMatchObject({
      type: "text",
      text: "列出系统里各 Python 解释器与常见环境管理器状态。Ubuntu 24.04.2。",
    });
  });
});
