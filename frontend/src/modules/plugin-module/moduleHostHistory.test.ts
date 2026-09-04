import { describe, expect, it } from "vitest";
import {
  diffTextLines,
  editorLanguageFromType,
  formatHistoryTime,
  historyItemId,
} from "./moduleHostHistory";
import { capabilityHistoryGetMethod, extractContent } from "./moduleHostContract";

describe("moduleHostHistory", () => {
  it("格式化时间戳与 ISO", () => {
    expect(formatHistoryTime("")).toBe("");
    expect(formatHistoryTime(1_700_000_000_000)).toMatch(/\d/);
    expect(formatHistoryTime("1700000000")).toMatch(/\d/);
    expect(formatHistoryTime("not-a-date")).toBe("not-a-date");
  });

  it("按配置类型推断编辑器语言", () => {
    expect(editorLanguageFromType("json")).toBe("json");
    expect(editorLanguageFromType("yml")).toBe("yaml");
    expect(editorLanguageFromType("properties")).toBe("ini");
    expect(editorLanguageFromType("unknown", "yaml")).toBe("yaml");
    expect(editorLanguageFromType("app.yaml")).toBe("yaml");
  });

  it("行级比对标出增删", () => {
    const lines = diffTextLines("a\nb\nc", "a\nx\nc");
    expect(lines).toEqual([
      { kind: "same", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "x" },
      { kind: "same", text: "c" },
    ]);
  });

  it("回退 getConfigHistory，并抽出正文", () => {
    expect(capabilityHistoryGetMethod({ id: "config", columns: [], actions: [] })).toBe(
      "getConfigHistory",
    );
    expect(
      capabilityHistoryGetMethod({
        id: "topic",
        columns: [],
        actions: [],
        historyGetMethod: "getTopicHistory",
      }),
    ).toBe("getTopicHistory");
    expect(extractContent({ content: "hello" })).toBe("hello");
    expect(extractContent({ data: "raw" })).toBe("raw");
    expect(historyItemId({ nid: "9" })).toBe("9");
  });
});
