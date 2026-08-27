import { describe, expect, it } from "vitest";
import {
  FIRST_PARTY_PLUGIN_MANIFESTS,
  getPluginManifest,
  listPluginManifests,
  manifestPanelTabIds,
  resolveLegacyPluginId,
} from "./pluginManifests";

describe("pluginManifests 单源目录", () => {
  it("解析全部第一方清单且 id 唯一", () => {
    const ids = FIRST_PARTY_PLUGIN_MANIFESTS.map((m) => m.id);
    expect(ids).toHaveLength(15);
    expect(new Set(ids).size).toBe(15);
  });

  it("kind 分布与仓库样板一致", () => {
    expect(listPluginManifests("engine").map((m) => m.id)).toEqual([
      "omni.engine.clickhouse",
      "omni.engine.mongodb",
      "omni.engine.mysql",
      "omni.engine.postgres",
      "omni.engine.qdrant",
      "omni.engine.redis",
      "omni.engine.sqlite",
      "omni.engine.sqlserver",
    ]);
    expect(listPluginManifests("panel")).toHaveLength(2);
    expect(listPluginManifests("module")).toHaveLength(1);
    expect(listPluginManifests("cloud")).toHaveLength(1);
    expect(listPluginManifests("theme")).toHaveLength(1);
    expect(listPluginManifests("addon")).toHaveLength(1);
    expect(listPluginManifests("importer")).toHaveLength(1);
  });

  it("getPluginManifest 命中与未命中", () => {
    expect(getPluginManifest("omni.panel.bt")?.kind).toBe("panel");
    expect(getPluginManifest("omni.unknown")).toBeNull();
  });

  it("ClickHouse 声明 T1 sidecar 运行时", () => {
    const ch = getPluginManifest("omni.engine.clickhouse");
    expect(ch?.runtime).toBe("sidecar");
    expect(ch?.entry?.driver).toBe("bin/omnipanel-engine-clickhouse");
  });

  it("Redis 声明进程内运行时", () => {
    const redis = getPluginManifest("omni.engine.redis");
    expect(redis?.runtime).toBe("inproc");
    expect(redis?.entry?.driver).toBeUndefined();
  });

  it("MongoDB 声明 T1 sidecar 运行时", () => {
    const mongo = getPluginManifest("omni.engine.mongodb");
    expect(mongo?.runtime).toBe("sidecar");
    expect(mongo?.entry?.driver).toBe("bin/omnipanel-engine-mongodb");
  });

  it("Qdrant 声明进程内运行时", () => {
    const qdrant = getPluginManifest("omni.engine.qdrant");
    expect(qdrant?.runtime).toBe("inproc");
    expect(qdrant?.entry?.driver).toBeUndefined();
  });

  it("MySQL / PG / SQLite 声明进程内运行时", () => {
    expect(getPluginManifest("omni.engine.mysql")?.runtime).toBe("inproc");
    expect(getPluginManifest("omni.engine.postgres")?.runtime).toBe("inproc");
    expect(getPluginManifest("omni.engine.sqlite")?.runtime).toBe("inproc");
  });

  it("SQL Server 为第一方 inproc 且 supported=true", () => {
    const form = getPluginManifest("omni.engine.sqlserver")?.contributes.ui?.connectionForm as
      | { supported?: boolean; engineKey?: string }
      | undefined;
    expect(form?.engineKey).toBe("sqlserver");
    expect(form?.supported).toBe(true);
  });

  it("manifestPanelTabIds 提取有效 id", () => {
    const bt = getPluginManifest("omni.panel.bt");
    expect(manifestPanelTabIds(bt)).toEqual([
      "overview",
      "websites",
      "apps",
      "certificates",
      "cronjobs",
      "databases",
    ]);
    expect(manifestPanelTabIds(null)).toEqual([]);
  });

  it("legacy 别名解析到插件 id", () => {
    expect(resolveLegacyPluginId("aliyun")).toBe("omni.cloud.aliyun");
    expect(resolveLegacyPluginId(" omni.cloud.aliyun ")).toBe("omni.cloud.aliyun");
    expect(resolveLegacyPluginId("unknown-provider")).toBeNull();
    expect(resolveLegacyPluginId("")).toBeNull();
  });
});
