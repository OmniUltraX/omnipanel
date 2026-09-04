import { describe, expect, it } from "vitest";
import { parsePluginManifest } from "@omnipanel/plugin-sdk";
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
    expect(ids).toHaveLength(17);
    expect(new Set(ids).size).toBe(17);
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
    expect(listPluginManifests("cloud")).toHaveLength(2);
    expect(listPluginManifests("theme")).toHaveLength(1);
    expect(listPluginManifests("addon")).toHaveLength(1);
    expect(listPluginManifests("importer")).toHaveLength(2);
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
    expect(manifestPanelTabIds(getPluginManifest("omni.panel.1panel"))).toEqual([
      "overview",
      "websites",
      "apps",
      "certificates",
      "cronjobs",
      "databases",
    ]);
    expect(manifestPanelTabIds(null)).toEqual([]);
  });

  it("面板插件声明 L2 数据库方法", () => {
    for (const id of ["omni.panel.1panel", "omni.panel.bt"] as const) {
      const methods = getPluginManifest(id)?.methods?.map((item) => item.name) ?? [];
      expect(methods).toEqual(
        expect.arrayContaining(["testConnection", "listDatabases", "createDatabase", "deleteDatabase"]),
      );
    }
  });

  it("示例 importer 用清单声明向导与首页入口", () => {
    const manifest = getPluginManifest("omni.importer.warpgate");
    const home = manifest?.contributes.ui?.home;
    const importer = manifest?.contributes.importers?.[0];
    expect(home?.show).toBe(true);
    expect(home?.open).toEqual({ kind: "importer", id: "warpgate" });
    expect(home?.icon).toBe("icon.svg");
    expect(importer?.id).toBe("warpgate");
    expect(importer?.fetchMethod).toBe("fetchTargets");
    expect(importer?.resourceKinds).toEqual(["ssh", "mysql", "postgres"]);
    expect(importer?.fields.some((field) => field.key === "token" && field.secretKeyPrefix === "src")).toBe(
      true,
    );
    expect(importer?.fields.some((field) => field.key === "insecureTls" && field.kind === "checkbox")).toBe(
      true,
    );
  });

  it("Docker 库扫描器声明 sourceKind 与 scanners，无 L2", () => {
    const manifest = getPluginManifest("omni.importer.docker-db");
    const home = manifest?.contributes.ui?.home;
    const importer = manifest?.contributes.importers?.[0];
    expect(manifest?.entry?.logic).toBeUndefined();
    expect(home?.open).toEqual({ kind: "importer", id: "docker-db" });
    expect(home?.icon).toBe("icon.svg");
    expect(importer?.id).toBe("docker-db");
    expect(importer?.sourceKind).toBe("dockerConnections");
    expect(importer?.fetchMethod).toBeUndefined();
    expect(importer?.scanners?.map((rule) => rule.id)).toEqual([
      "mysql",
      "postgres",
      "redis",
      "mongodb",
      "clickhouse",
      "sqlserver",
      "qdrant",
      "dameng",
      "cassandra",
      "neo4j",
    ]);
  });

  it("阿里云声明 capabilities 而非 ecs panelTabs", () => {
    const manifest = getPluginManifest("omni.cloud.aliyun");
    expect(manifest?.kind).toBe("cloud");
    expect(manifestPanelTabIds(manifest)).toEqual([]);
    expect(manifest?.contributes.cloud?.capabilities.map((c) => c.id)).toEqual([
      "compute",
      "compute.lite",
      "network.securityGroup",
      "network.eip",
      "network.loadBalancer",
      "database",
      "database.cache",
      "storage.disk",
      "objectStorage",
      "domains",
      "certs",
    ]);
    expect(manifest?.methods?.map((m) => m.name)).toEqual(
      expect.arrayContaining(["listResources", "invokeAction"]),
    );
  });

  it("腾讯云声明相同 capabilities", () => {
    const manifest = getPluginManifest("omni.cloud.tencent");
    expect(manifest?.kind).toBe("cloud");
    expect(manifestPanelTabIds(manifest)).toEqual([]);
    expect(manifest?.contributes.cloud?.capabilities.map((c) => c.id)).toEqual([
      "compute",
      "compute.lite",
      "network.securityGroup",
      "network.eip",
      "network.loadBalancer",
      "database",
      "database.cache",
      "storage.disk",
      "objectStorage",
      "domains",
      "certs",
    ]);
  });

  it("Nacos module 声明 methods、logic 与四种 capability", () => {
    const manifest = getPluginManifest("omni.module.nacos");
    expect(manifest?.kind).toBe("module");
    expect(manifest?.entry?.logic).toBe("logic.js");
    expect(manifest?.contributes.ui?.moduleKey).toBe("nacos");
    expect(manifest?.contributes.module?.capabilities.map((item) => item.id)).toEqual([
      "namespace",
      "config",
      "discovery",
      "cluster",
    ]);
    expect(manifest?.methods?.map((item) => item.name)).toEqual(
      expect.arrayContaining([
        "testConnection",
        "publishConfig",
        "rollbackConfig",
        "listServices",
        "listItems",
        "probeHealth",
        "omni_nacos_list_namespaces",
      ]),
    );
    expect(manifest?.contributes.module?.capabilities.find((c) => c.id === "config")?.detail).toBe(
      "editor",
    );
    expect(manifest?.contributes.module?.capabilities.find((c) => c.id === "discovery")?.childListMethod).toBe(
      "listInstances",
    );
    expect(manifest?.contributes.launcher?.prefix).toBe("nacos");
    expect(manifest?.contributes.discovery?.some((item) => item.probeId === "module-http")).toBe(true);
    const writeTools = (manifest?.contributes.ai?.tools ?? []).map((item) => item.name);
    expect(writeTools).not.toEqual(expect.arrayContaining(["publishConfig", "rollbackConfig"]));
    expect(writeTools).toHaveLength(4);
  });

  it("legacy 别名解析到插件 id", () => {
    expect(resolveLegacyPluginId("aliyun")).toBe("omni.cloud.aliyun");
    expect(resolveLegacyPluginId(" omni.cloud.aliyun ")).toBe("omni.cloud.aliyun");
    expect(resolveLegacyPluginId("tencent")).toBe("omni.cloud.tencent");
    expect(resolveLegacyPluginId("qcloud")).toBe("omni.cloud.tencent");
    expect(resolveLegacyPluginId("unknown-provider")).toBeNull();
    expect(resolveLegacyPluginId("")).toBeNull();
  });

  it("后端 reserialize 的显式 null 缺省可解析（translate-float 安装回归）", () => {
    // plugin_peek_manifest 返回 Rust reserialize 的 JSON：缺省曾是显式 null，
    // zod 必须容忍（nullish），否则第三方包在权限确认前就被卡死。
    const manifest = parsePluginManifest({
      id: "omni.sample.translate-float",
      version: "0.1.0",
      kind: "addon",
      permissions: ["ui:selection", "ai:tools"],
      entry: { ui: "ui/main.js" },
      minHostApi: 1,
      contributes: {
        ui: {
          sidebar: false,
          moduleKey: "",
          connectionForm: null,
          panelTabs: [],
          commands: [],
          workbench: null,
          home: null,
        },
        menus: [],
        overlays: [{ id: "translator", title: "选中翻译", entry: "ui/index.html" }],
        discovery: [],
        importers: [],
        cloud: null,
        module: null,
      },
    });
    expect(manifest.id).toBe("omni.sample.translate-float");
    expect(manifest.contributes.ui?.workbench).toBeNull();
    expect(manifest.entry?.ui).toBe("ui/main.js");
  });
});
