import { describe, expect, it } from "vitest";
import { parsePluginManifest } from "@omnipanel/plugin-sdk";
import { setInstalledPluginManifests } from "../../lib/pluginManifests";
import {
  getEngineDescriptor,
  getEngineWorkbench,
  isRegisteredEngine,
  listEngineDescriptors,
  resolveEngineKey,
} from "./engineRegistry";

describe("engineRegistry 只从引擎插件水合", () => {
  it("MySQL / PG / SQLite 来自插件清单而不是硬编码", () => {
    setInstalledPluginManifests([]);
    expect(getEngineDescriptor("mysql")?.pluginId).toBe("omni.engine.mysql");
    expect(getEngineDescriptor("mariadb")?.id).toBe("mysql");
    expect(getEngineDescriptor("postgresql")?.pluginId).toBe("omni.engine.postgres");
    expect(resolveEngineKey("pg")).toBe("postgresql");
    expect(getEngineDescriptor("sqlite")?.pluginId).toBe("omni.engine.sqlite");
    expect(getEngineDescriptor("sqlite")?.form.fields.some((f) => f.type === "path")).toBe(true);
    expect(listEngineDescriptors().map((item) => item.id)).toEqual([
      "mysql",
      "postgresql",
      "sqlite",
      "sqlserver",
      "redis",
      "mongodb",
      "qdrant",
      "clickhouse",
    ]);
  });

  it("SQL Server 为第一方可用引擎", () => {
    expect(getEngineDescriptor("sqlserver")?.pluginId).toBe("omni.engine.sqlserver");
    expect(getEngineDescriptor("mssql")?.id).toBe("sqlserver");
    expect(isRegisteredEngine("sqlserver")).toBe(true);
    expect(listEngineDescriptors().some((item) => item.id === "sqlserver" && item.supported)).toBe(
      true,
    );
  });

  it("工作台插槽仍按清单贡献", () => {
    expect(getEngineWorkbench("mysql").tree).toBe("schema");
    expect(getEngineWorkbench("redis").tree).toBe("kv");
    expect(getEngineWorkbench("mongodb").tree).toBe("documents");
  });

  it("已安装 DBX sidecar 引擎进入连接芯片", () => {
    setInstalledPluginManifests([
      parsePluginManifest({
        id: "omni.engine.oracle",
        version: "0.1.0",
        kind: "engine",
        runtime: "sidecar",
        permissions: ["net:connect"],
        entry: { driver: "bin/agent.mjs" },
        contributes: {
          ui: {
            connectionForm: {
              engineKey: "oracle",
              aliases: ["oracle", "orcl"],
              defaultPort: 1521,
              icon: "OR",
              order: 90,
              builtinLayout: false,
              fields: [
                { key: "host", type: "text" },
                { key: "port", type: "number" },
                { key: "sid", type: "text", optional: true, label: "SID" },
                { key: "sysdba", type: "checkbox", optional: true, label: "SYSDBA" },
              ],
            },
            workbench: {
              tree: "schema",
              editor: "sql",
              preview: "grid",
              connectionInfo: "sql",
            },
          },
        },
      }),
    ]);
    try {
      expect(isRegisteredEngine("oracle")).toBe(true);
      expect(getEngineDescriptor("orcl")?.pluginId).toBe("omni.engine.oracle");
      expect(getEngineDescriptor("oracle")?.defaultPort).toBe(1521);
      const keys = getEngineDescriptor("oracle")?.form.fields.map((f) => f.key) ?? [];
      expect(keys).toContain("sid");
      expect(keys).toContain("sysdba");
      expect(getEngineDescriptor("oracle")?.builtinLayout).toBe(false);
      expect(listEngineDescriptors().some((item) => item.id === "oracle")).toBe(true);
    } finally {
      setInstalledPluginManifests([]);
    }
  });
});
