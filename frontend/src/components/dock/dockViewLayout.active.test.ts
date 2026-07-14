import { describe, expect, it } from "vitest";
import type { SerializedDockview } from "dockview-core";
import { createDefaultLayout, mergePanelsIntoLayout } from "./dockViewLayout";

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
