import { describe, expect, it } from "vitest";
import {
  appendTextLikePart,
  deriveCompatFields,
  partsFromFlatFields,
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
});
