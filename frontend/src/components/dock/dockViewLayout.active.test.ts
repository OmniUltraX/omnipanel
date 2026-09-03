import { describe, expect, it } from "vitest";
import type { SerializedDockview } from "dockview-core";
import {
  canApplyDockLayoutIncrementally,
  createDefaultLayout,
  isLayoutUsable,
  mergePanelsIntoLayout,
  normalizeDockLayout,
  safeLayoutForFromJson,
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

describe("normalizeDockLayout", () => {
  it("剥除 tabGroups 与重复 views，避免 fromJSON invalid location", () => {
    const dirty = createDefaultLayout(["a", "b"], "a") as SerializedDockview & {
      grid: { root: { type: string; data: unknown } };
    };
    const root = dirty.grid.root as {
      type: "branch";
      data: Array<{
        type: "leaf";
        data: { id: string; views: string[]; activeView?: string; tabGroups?: unknown };
      }>;
    };
    const leaf = root.data[0]!;
    leaf.data.views = ["a", "a", "b"];
    leaf.data.tabGroups = [{ id: "tg-0", panelIds: ["a", "b"], collapsed: false }];
    const cleaned = normalizeDockLayout(dirty);
    const cleanedLeaf = (
      cleaned!.grid.root as {
        type: "branch";
        data: Array<{ type: "leaf"; data: { views: string[]; tabGroups?: unknown } }>;
      }
    ).data[0]!;
    expect(cleanedLeaf.data.views).toEqual(["a", "b"]);
    expect(cleanedLeaf.data.tabGroups).toBeUndefined();
  });

  it("跨 leaf 重复 view 只保留首次出现", () => {
    const layout = createDefaultLayout(["a", "b"], "a");
    const split: SerializedDockview = {
      ...layout,
      grid: {
        ...layout.grid,
        root: {
          type: "branch",
          data: [
            {
              type: "leaf",
              data: { id: "g1", views: ["a", "b"], activeView: "a" },
              size: 500,
            },
            {
              type: "leaf",
              data: { id: "g2", views: ["b"], activeView: "b" },
              size: 500,
            },
          ],
        } as SerializedDockview["grid"]["root"],
      },
    };
    const cleaned = normalizeDockLayout(split);
    const leaves = (
      cleaned!.grid.root as {
        type: "branch";
        data: Array<{ type: "leaf"; data: { id: string; views: string[] } }>;
      }
    ).data;
    expect(leaves).toHaveLength(1);
    expect(leaves[0]!.data.views).toEqual(["a", "b"]);
    expect(isLayoutUsable(cleaned)).toBe(true);
  });

  it("重复 group id 会被改名", () => {
    const layout = createDefaultLayout(["a", "b"], "a");
    const split: SerializedDockview = {
      ...layout,
      grid: {
        ...layout.grid,
        root: {
          type: "branch",
          data: [
            {
              type: "leaf",
              data: { id: "same", views: ["a"], activeView: "a" },
              size: 500,
            },
            {
              type: "leaf",
              data: { id: "same", views: ["b"], activeView: "b" },
              size: 500,
            },
          ],
        } as SerializedDockview["grid"]["root"],
      },
    };
    const cleaned = normalizeDockLayout(split);
    const leaves = (
      cleaned!.grid.root as {
        type: "branch";
        data: Array<{ type: "leaf"; data: { id: string } }>;
      }
    ).data;
    expect(leaves[0]!.data.id).toBe("same");
    expect(leaves[1]!.data.id).not.toBe("same");
    expect(isLayoutUsable(cleaned)).toBe(true);
  });
});

describe("safeLayoutForFromJson", () => {
  it("带 tabGroups 的脏布局洗完后可用", () => {
    const dirty = createDefaultLayout(["a", "b"], "a") as SerializedDockview & {
      grid: { root: { type: string; data: unknown } };
    };
    const root = dirty.grid.root as {
      type: "branch";
      data: Array<{ type: "leaf"; data: { tabGroups?: unknown } }>;
    };
    root.data[0]!.data.tabGroups = [{ id: "tg-0", panelIds: ["a", "b"] }];
    expect(isLayoutUsable(dirty)).toBe(false);
    const safe = safeLayoutForFromJson(dirty, ["a", "b"], "a");
    expect(safe).not.toBeNull();
    expect(isLayoutUsable(safe)).toBe(true);
  });

  it("仍有风险时退回单 group 默认布局", () => {
    const broken = {
      grid: {
        root: { type: "leaf", data: { id: "g", views: ["ghost"] } },
        width: 0,
        height: 0,
        orientation: 1,
      },
      panels: {},
    } as unknown as SerializedDockview;
    const safe = safeLayoutForFromJson(broken, ["a", "b"], "b");
    expect(safe).not.toBeNull();
    expect(isLayoutUsable(safe)).toBe(true);
    expect(Object.keys(safe!.panels)).toEqual(["a", "b"]);
    const leaf = (
      safe!.grid.root as {
        type: "branch";
        data: Array<{ type: "leaf"; data: { views: string[]; activeView?: string } }>;
      }
    ).data[0]!;
    expect(leaf.data.views).toEqual(["a", "b"]);
    expect(leaf.data.activeView).toBe("b");
  });
});
