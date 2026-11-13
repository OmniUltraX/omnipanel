import { describe, expect, it } from "vitest";
import { mergePlacementTree } from "./mergeLayoutTree";

describe("mergePlacementTree", () => {
  it("同名根文件夹合成一个，另一台独有的文件夹和主机会留下", () => {
    const remote = {
      folders: [{ id: "b", name: "~/.ssh/config", parentId: null }],
      connectionFolderId: { h2: "b" },
      orderByParent: { __root__: ["f:b"], b: ["c:h2"] },
    };
    const local = {
      folders: [
        { id: "a", name: "~/.ssh/config", parentId: null },
        { id: "w", name: "Warpgate", parentId: null },
      ],
      connectionFolderId: { h1: "w", h2: "a" },
      orderByParent: { __root__: ["f:a", "f:w"], w: ["c:h1"], a: ["c:h2"] },
    };
    const merged = mergePlacementTree(remote, local);
    expect(merged.folders.map((folder) => folder.name)).toEqual(["~/.ssh/config", "Warpgate"]);
    expect(merged.folders.filter((folder) => folder.name === "~/.ssh/config")).toHaveLength(1);
    expect(merged.connectionFolderId.h1).toBe("w");
    expect(merged.connectionFolderId.h2).toBe("b");
    expect(merged.orderByParent.__root__).toContain("f:w");
    expect(merged.orderByParent.__root__.filter((key) => key === "f:b")).toHaveLength(1);
    expect(merged.orderByParent.w).toEqual(["c:h1"]);
  });
});
