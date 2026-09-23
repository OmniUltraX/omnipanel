import { describe, expect, it } from "vitest";
import { allocateSqlFileStem } from "./allocateSqlFileStem";

describe("allocateSqlFileStem", () => {
  it("空目录用默认名", () => {
    expect(allocateSqlFileStem([], null, "query")).toBe("query");
  });

  it("已有 query.sql 时追加序号，扩展名仍在末尾", () => {
    const nodes = [
      { parentId: null, type: "file", name: "query.sql" },
      { parentId: null, type: "file", name: "query 2.sql" },
    ];
    expect(allocateSqlFileStem(nodes, null, "query")).toBe("query 3");
  });

  it("不同目录互不影响", () => {
    const nodes = [{ parentId: "folder-a", type: "file", name: "query.sql" }];
    expect(allocateSqlFileStem(nodes, "folder-b", "query")).toBe("query");
  });
});
