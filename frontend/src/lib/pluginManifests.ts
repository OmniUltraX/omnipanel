import {
  parsePluginManifest,
  type PluginKind,
  type PluginManifest,
} from "@omnipanel/plugin-sdk";
import addonEverythingJson from "../../../plugins/addon-everything/plugin.json";
import cloudAliyunJson from "../../../plugins/cloud-aliyun/plugin.json";
import cloudTencentJson from "../../../plugins/cloud-tencent/plugin.json";
import dbClickhouseJson from "../../../plugins/db-clickhouse/plugin.json";
import dbMongodbJson from "../../../plugins/db-mongodb/plugin.json";
import dbMysqlJson from "../../../plugins/db-mysql/plugin.json";
import dbPostgresJson from "../../../plugins/db-postgres/plugin.json";
import dbQdrantJson from "../../../plugins/db-qdrant/plugin.json";
import dbRedisJson from "../../../plugins/db-redis/plugin.json";
import dbSqliteJson from "../../../plugins/db-sqlite/plugin.json";
import dbSqlserverJson from "../../../plugins/db-sqlserver/plugin.json";
import importerDockerDbJson from "../../../plugins/importer-docker-db/plugin.json";
import importerWarpgateJson from "../../../plugins/importer-warpgate/plugin.json";
import moduleNacosJson from "../../../plugins/module-nacos/plugin.json";
import panel1panelJson from "../../../plugins/panel-1panel/plugin.json";
import panelBtJson from "../../../plugins/panel-bt/plugin.json";
import themeDefaultJson from "../../../plugins/theme-default/plugin.json";

/**
 * 第一方清单唯一前端事实源：与仓库 `plugins/` 目录一一对应，
 * 完整性由 `scripts/check-plugin-manifests.mjs` 校验。
 * 消费方 MUST 从此处按 kind/id 查询，禁止直接 import `plugins/*`。
 */
export const FIRST_PARTY_PLUGIN_MANIFESTS: readonly PluginManifest[] = [
  parsePluginManifest(addonEverythingJson),
  parsePluginManifest(cloudAliyunJson),
  parsePluginManifest(cloudTencentJson),
  parsePluginManifest(dbClickhouseJson),
  parsePluginManifest(dbMongodbJson),
  parsePluginManifest(dbMysqlJson),
  parsePluginManifest(dbPostgresJson),
  parsePluginManifest(dbQdrantJson),
  parsePluginManifest(dbRedisJson),
  parsePluginManifest(dbSqliteJson),
  parsePluginManifest(dbSqlserverJson),
  parsePluginManifest(importerDockerDbJson),
  parsePluginManifest(importerWarpgateJson),
  parsePluginManifest(moduleNacosJson),
  parsePluginManifest(panel1panelJson),
  parsePluginManifest(panelBtJson),
  parsePluginManifest(themeDefaultJson),
];

export function listPluginManifests(kind?: PluginKind): PluginManifest[] {
  const all: PluginManifest[] = [...FIRST_PARTY_PLUGIN_MANIFESTS, ...INSTALLED_PLUGIN_MANIFESTS];
  return kind ? all.filter((m) => m.kind === kind) : all;
}

export function getPluginManifest(id: string): PluginManifest | null {
  return (
    FIRST_PARTY_PLUGIN_MANIFESTS.find((m) => m.id === id) ??
    INSTALLED_PLUGIN_MANIFESTS.find((m) => m.id === id) ??
    null
  );
}

/** 运行期合并的磁盘安装清单（经 `plugin_manifests` IPC 由 Runtime Store 灌入）。 */
let INSTALLED_PLUGIN_MANIFESTS: PluginManifest[] = [];

export function setInstalledPluginManifests(list: PluginManifest[]): void {
  INSTALLED_PLUGIN_MANIFESTS = [...list];
}

export function listInstalledPluginManifests(): PluginManifest[] {
  return [...INSTALLED_PLUGIN_MANIFESTS];
}

/** 从 `contributes.ui.panelTabs` 提取有效 tab id。 */
export function manifestPanelTabIds(manifest: PluginManifest | null): string[] {
  const tabs = manifest?.contributes.ui?.panelTabs;
  if (!Array.isArray(tabs)) return [];
  return tabs
    .map((tab) =>
      tab && typeof tab === "object" && typeof (tab as { id?: unknown }).id === "string"
        ? ((tab as { id: string }).id.trim() || null)
        : null,
    )
    .filter((id): id is string => Boolean(id));
}

/** legacy 连接字段值 → 插件 id（迁移映射，集中维护；新插件 MUST 用自身 id）。 */
export const LEGACY_PLUGIN_ALIASES: Readonly<Record<string, string>> = {
  aliyun: "omni.cloud.aliyun",
  tencent: "omni.cloud.tencent",
  qcloud: "omni.cloud.tencent",
};

export function manifestCloudCapabilities(
  manifest: PluginManifest | null,
): import("@omnipanel/plugin-sdk").CloudCapabilityDecl[] {
  if (!manifest || manifest.kind !== "cloud") return [];
  return manifest.contributes.cloud?.capabilities ?? [];
}

export function resolveLegacyPluginId(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return null;
  if (getPluginManifest(value)) return value;
  return LEGACY_PLUGIN_ALIASES[value] ?? null;
}
