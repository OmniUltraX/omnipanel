import { describe, expect, it } from "vitest";
import type { DbxCatalogDriver } from "../../../ipc/bindings";
import type { EngineDescriptor } from "../engineRegistry";
import { SQL_WORKBENCH } from "../workbench/engineWorkbench";
import {
  buildEnginePickerItems,
  canonicalPickerEngineId,
  categoriesWithItems,
  categoryForEngine,
  filterPickerItems,
  isEngineInstalling,
} from "./enginePicker";

function desc(id: string): EngineDescriptor {
  return {
    id,
    aliases: [id],
    defaultPort: 1,
    icon: "X",
    builtinLayout: true,
    supported: true,
    order: 1,
    form: { fields: [] },
    workbench: SQL_WORKBENCH,
  };
}

function catalog(partial: Partial<DbxCatalogDriver> & Pick<DbxCatalogDriver, "key">): DbxCatalogDriver {
  return {
    pluginId: `omni.engine.${partial.key}`,
    label: partial.label ?? partial.key,
    version: "0.1.0",
    defaultPort: 0,
    size: 1,
    artifactKind: "native",
    installed: false,
    installedVersion: null,
    ...partial,
    createdAt: partial.createdAt ?? null,
    updatedAt: partial.updatedAt ?? null,
    downloads: partial.downloads ?? null,
  };
}

describe("enginePicker", () => {
  it("归一化 postgres / dm 等到 OmniPanel 引擎 id", () => {
    expect(canonicalPickerEngineId("postgres")).toBe("postgresql");
    expect(canonicalPickerEngineId("dm")).toBe("dameng");
    expect(canonicalPickerEngineId("mssql")).toBe("sqlserver");
  });

  it("按 DBX 分组：达梦国产、Neo4j 图、Cassandra 文档", () => {
    expect(categoryForEngine("dameng")).toBe("domestic");
    expect(categoryForEngine("neo4j")).toBe("graph_ai");
    expect(categoryForEngine("cassandra")).toBe("document");
    expect(categoryForEngine("postgresql")).toBe("sql");
  });

  it("已装第一方可用，目录未安装灰色", () => {
    const items = buildEnginePickerItems(
      [desc("mysql"), desc("postgresql")],
      [catalog({ key: "neo4j", label: "Neo4j", installed: false }), catalog({ key: "oracle", label: "oracle", installed: true })],
    );
    expect(items.find((i) => i.id === "mysql")?.available).toBe(true);
    expect(items.find((i) => i.id === "mysql")?.fromDbx).toBe(false);
    expect(items.find((i) => i.id === "neo4j")?.available).toBe(false);
    expect(items.find((i) => i.id === "neo4j")?.fromDbx).toBe(true);
    expect(items.find((i) => i.id === "oracle")?.available).toBe(true);
    expect(items.find((i) => i.id === "oracle")?.fromDbx).toBe(true);
    expect(items.find((i) => i.id === "oracle")?.label).toBe("oracle");
  });

  it("目录已装且第一方已有时仍保持可用并带上 catalogKey", () => {
    const items = buildEnginePickerItems(
      [desc("mysql")],
      [catalog({ key: "mysql", label: "MySQL", installed: true })],
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.available).toBe(true);
    expect(items[0]?.catalogKey).toBe("mysql");
    expect(items[0]?.fromDbx).toBe(false);
  });

  it("搜索跨分组，未搜索时只显示当前分组", () => {
    const items = buildEnginePickerItems(
      [desc("mysql"), desc("redis")],
      [catalog({ key: "neo4j", label: "Neo4j" })],
    );
    expect(filterPickerItems(items, "sql", "").map((i) => i.id)).toEqual(["mysql"]);
    expect(filterPickerItems(items, "sql", "neo").map((i) => i.id)).toEqual(["neo4j"]);
    expect(categoriesWithItems(items)).toEqual(["sql", "document", "graph_ai"]);
  });

  it("已装的非第一方插件仍算 DBX 源", () => {
    const items = buildEnginePickerItems(
      [desc("mysql"), desc("hive")],
      [catalog({ key: "hive", label: "Apache Hive", installed: true })],
    );
    expect(items.find((i) => i.id === "mysql")?.fromDbx).toBe(false);
    expect(items.find((i) => i.id === "hive")?.fromDbx).toBe(true);
  });

  it("安装中状态不把 catalogKey 为空的第一方引擎当成安装中", () => {
    expect(isEngineInstalling(null, null)).toBe(false);
    expect(isEngineInstalling(null, "mysql")).toBe(false);
    expect(isEngineInstalling("neo4j", "neo4j")).toBe(true);
    expect(isEngineInstalling("neo4j", "oracle")).toBe(false);
  });

  it("已装 DBX 引擎可卸载，版本落后显示升级", () => {
    const items = buildEnginePickerItems(
      [desc("mysql")],
      [
        catalog({
          key: "oracle",
          label: "oracle",
          installed: true,
          version: "0.2.0",
          installedVersion: "0.1.0",
        }),
        catalog({ key: "hive", label: "Hive", installed: false, version: "0.1.0" }),
      ],
    );
    const oracle = items.find((i) => i.id === "oracle");
    expect(oracle?.available).toBe(true);
    expect(oracle?.needsUpgrade).toBe(true);
    expect(oracle?.pluginId).toBe("omni.engine.oracle");
    const hive = items.find((i) => i.id === "hive");
    expect(hive?.available).toBe(false);
    expect(hive?.needsUpgrade).toBe(false);
  });

  it("卸载后 picker available=false", () => {
    const before = buildEnginePickerItems(
      [desc("mysql")],
      [catalog({ key: "dameng", label: "达梦", installed: true, installedVersion: "0.1.56" })],
    );
    expect(before.find((i) => i.id === "dameng")?.available).toBe(true);
    const after = buildEnginePickerItems(
      [desc("mysql")],
      [catalog({ key: "dameng", label: "达梦", installed: false, installedVersion: null })],
    );
    expect(after.find((i) => i.id === "dameng")?.available).toBe(false);
  });
});
