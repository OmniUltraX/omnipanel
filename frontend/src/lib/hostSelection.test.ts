import { describe, expect, it, vi, afterEach } from "vitest";
import { getHostSelection, setTerminalSelection } from "./hostSelection";

describe("hostSelection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setTerminalSelection("");
  });

  it("prefers terminal selection over empty DOM", () => {
    setTerminalSelection("ls -la");
    expect(getHostSelection()).toEqual({ text: "ls -la", source: "terminal" });
    setTerminalSelection("  ");
    const next = getHostSelection();
    expect(next == null || next.source === "dom").toBe(true);
  });

  it("后变化的 DOM 选区盖住常驻终端选区（文档↔终端来回不出浮标的根因）", () => {
    // 先在终端选中（常驻不清）
    setTerminalSelection("term-stale");
    expect(getHostSelection()?.text).toBe("term-stale");
    // 后在文档选中：DOM 更新、更新鲜，必须胜出
    vi.spyOn(window, "getSelection").mockReturnValue({
      toString: () => "doc-fresh",
    } as Selection);
    expect(getHostSelection()).toEqual({ text: "doc-fresh", source: "dom" });
  });

  it("DOM 收起后回退常驻终端选区（overlay 内读选区老链路）", () => {
    setTerminalSelection("term-stale");
    vi.spyOn(window, "getSelection").mockReturnValue({
      toString: () => "  ",
    } as Selection);
    expect(getHostSelection()).toEqual({ text: "term-stale", source: "terminal" });
  });
});
