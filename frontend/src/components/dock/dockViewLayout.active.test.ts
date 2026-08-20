import { describe, expect, it } from "vitest";
import type { SerializedDockview } from "dockview-core";
import {
  canApplyDockLayoutIncrementally,
  createDefaultLayout,
  mergePanelsIntoLayout,
} from "./dockViewLayout";

function readActiveView(layout: SerializedDockview): string | undefined {
  const walk = (node: SerializedDockview["grid"]["root"]): string | undefined => {
    if (!node) return undefined;
    if (node.type === "leaf") {
      const data = node.data as { activeView?: string } | undefined;
      return data?.activeView;
    }
    if (node.type === "branch" && Array.isArray(node.data)) {
      for (const child of node.data) {
        const found = walk(child as SerializedDockview["grid"]["root"]);
        if (found) return found;
      }
    }
    return undefined;
  };
  return walk(layout.grid.root);
}

describe("mergePanelsIntoLayout active tab", () => {
  it("新建布局时尊重 activeTabId", () => {
    const layout = mergePanelsIntoLayout(null, ["monitor", "files", "history"], "files");
    expect(layout).not.toBeNull();
    expect(readActiveView(layout!)).toBe("files");
  });

  it("已有布局时同步 activeView 到目标 tab", () => {
    const base = createDefaultLayout(["monitor", "files", "history"], "monitor");
    const layout = mergePanelsIntoLayout(base, ["monitor", "files", "history"], "history");
    expect(readActiveView(layout!)).toBe("history");
  });
});

describe("canApplyDockLayoutIncrementally", () => {
  it("关一个已挂载 Tab 时走增量，避免 fromJSON 重建其余面板", () => {
    expect(
      canApplyDockLayoutIncrementally(
        ["term-a", "term-b", "term-c"],
        ["term-a", "term-b"],
        ["term-a", "term-b"],
      ),
    ).toBe(true);
  });

  it("dockview 已先移除 panel 且布局与剩余 Tab 一致时也走增量", () => {
    expect(
      canApplyDockLayoutIncrementally(["term-a", "term-b"], ["term-a", "term-b"], ["term-a", "term-b"]),
    ).toBe(true);
  });

  it("布局引入尚未挂载的 panel 时必须 fromJSON", () => {
    expect(
      canApplyDockLayoutIncrementally(["term-a"], ["term-a", "term-b"], ["term-a", "term-b"]),
    ).toBe(false);
  });

  it("布局滞后（tabs 仍包含 API 多出的 panel）时不能当增量删除", () => {
    expect(
      canApplyDockLayoutIncrementally(
        ["term-a", "term-b"],
        ["term-a"],
        ["term-a", "term-b"],
      ),
    ).toBe(false);
  });

  it("空布局不走增量（交给 clear 路径）", () => {
    expect(canApplyDockLayoutIncrementally(["term-a"], [], [])).toBe(false);
  });
});
