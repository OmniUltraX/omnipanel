import { describe, expect, it } from "vitest";
import { resolveSidebarTreeDeleteTargets } from "./resolveSidebarTreeDeleteTargets";

describe("resolveSidebarTreeDeleteTargets", () => {
  it("未多选时只返回点击项", () => {
    expect(resolveSidebarTreeDeleteTargets("a", new Set(["a"]))).toEqual(["a"]);
    expect(resolveSidebarTreeDeleteTargets("a", new Set())).toEqual(["a"]);
    expect(resolveSidebarTreeDeleteTargets("a", null)).toEqual(["a"]);
  });

  it("点击项在多选集合中时返回全部选中项", () => {
    expect(resolveSidebarTreeDeleteTargets("b", new Set(["a", "b", "c"]))).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("点击项不在多选集合中时只删点击项", () => {
    expect(resolveSidebarTreeDeleteTargets("x", new Set(["a", "b"]))).toEqual(["x"]);
  });

  it("支持 filter 收窄同类节点", () => {
    const selected = new Set(["docker:c1", "docker:c1:containers", "docker:c2"]);
    expect(
      resolveSidebarTreeDeleteTargets("docker:c1", selected, {
        filter: (id) => /^docker:[^:]+$/.test(id),
      }),
    ).toEqual(["docker:c1", "docker:c2"]);
  });
});
