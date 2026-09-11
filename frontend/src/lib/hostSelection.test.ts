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

  it("输入框内的选中可被读到（表格单元格编辑器浮标的根因）", () => {
    const input = document.createElement("input");
    input.value = "杨建姐 15266943180";
    document.body.appendChild(input);
    input.focus();
    input.setSelectionRange(0, 3);
    try {
      expect(getHostSelection()).toEqual({ text: "杨建姐", source: "dom" });
    } finally {
      document.body.removeChild(input);
    }
  });

  it("输入框选区收起时返回 null（不误报）", () => {
    const area = document.createElement("textarea");
    area.value = "hello";
    document.body.appendChild(area);
    area.focus();
    area.setSelectionRange(2, 2);
    try {
      expect(getHostSelection()).toBeNull();
    } finally {
      document.body.removeChild(area);
    }
  });
});
