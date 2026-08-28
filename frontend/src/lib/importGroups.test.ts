import { describe, expect, it } from "vitest";
import {
  collectImportGroupSuggestions,
  defaultImportGroups,
  findSidebarFolder,
  importGroupDest,
  importGroupKeyForCandidate,
  listSidebarFolderPaths,
  resolveImportGroupFields,
  sanitizeImportGroupInput,
  sidebarFolderPath,
} from "./importGroups";

describe("collectImportGroupSuggestions", () => {
  it("空值表示根级，不伪造默认分组", () => {
    expect(collectImportGroupSuggestions(["测试", "", "生产"], "")).toEqual(["测试", "生产"]);
    expect(sanitizeImportGroupInput("  ")).toBe("");
    expect(sanitizeImportGroupInput("项目 A")).toBe("项目 A");
  });
});

describe("sidebarFolderPath", () => {
  const folders = [
    { id: "a", name: "生产", parentId: null },
    { id: "b", name: "项目", parentId: "a" },
  ];

  it("嵌套文件夹用路径展示", () => {
    expect(sidebarFolderPath(folders, "b")).toBe("生产 / 项目");
    expect(listSidebarFolderPaths(folders)).toEqual(["生产", "生产 / 项目"]);
    expect(findSidebarFolder(folders, "生产 / 项目")?.id).toBe("b");
    expect(findSidebarFolder(folders, "生产")?.id).toBe("a");
  });
});

describe("resolveImportGroupFields", () => {
  it("Docker 库扫描只有数据库一个分组", () => {
    expect(resolveImportGroupFields({ sourceKind: "dockerConnections" })).toEqual([
      { kind: "database", dest: "database" },
    ]);
  });

  it("Warpgate 的 MySQL/PostgreSQL 合并成一个数据库分组", () => {
    expect(
      resolveImportGroupFields({
        resourceKinds: ["ssh", "mysql", "postgres"],
      }),
    ).toEqual([
      { kind: "ssh", dest: "ssh" },
      { kind: "database", dest: "database" },
    ]);
  });
});

describe("importGroupDest", () => {
  it("按资源落到对应模块", () => {
    expect(importGroupDest("ssh")).toBe("ssh");
    expect(importGroupDest("mysql")).toBe("database");
    expect(importGroupKeyForCandidate("instances", "mysql")).toBe("database");
  });
});

describe("defaultImportGroups", () => {
  it("数据库默认挂根级，SSH 用导入器默认名", () => {
    expect(
      defaultImportGroups(
        [
          { kind: "ssh", dest: "ssh" },
          { kind: "database", dest: "database" },
        ],
        { defaultGroup: "Warpgate" },
      ),
    ).toEqual({ ssh: "Warpgate", database: "" });
  });
});
