import { getPluginManifest } from "../../lib/pluginManifests";

const PLUGIN_ID_EVERYTHING = "omni.addon.everything";

const PLUGIN_NAME_KEYS: Record<string, string> = {
  [PLUGIN_ID_EVERYTHING]: "plugins.names.everything",
  "omni.cloud.aliyun": "plugins.names.aliyun",
  "omni.cloud.tencent": "plugins.names.tencent",
  "omni.cloud.huawei": "plugins.names.huawei",
  "omni.cloud.aws": "plugins.names.aws",
  "omni.cloud.azure": "plugins.names.azure",
  "omni.cloud.digitalocean": "plugins.names.digitalocean",
  "omni.cloud.gcp": "plugins.names.gcp",
  "omni.cloud.bandwagon": "plugins.names.bandwagon",
  "omni.cloud.qiniu": "plugins.names.qiniu",
  "omni.cloud.jdcloud": "plugins.names.jdcloud",
  "omni.engine.qdrant": "plugins.names.qdrant",
  "omni.engine.clickhouse": "plugins.names.clickhouse",
  "omni.engine.mongodb": "plugins.names.mongodb",
  "omni.engine.mysql": "plugins.names.mysql",
  "omni.engine.postgres": "plugins.names.postgres",
  "omni.engine.sqlite": "plugins.names.sqlite",
  "omni.engine.sqlserver": "plugins.names.sqlserver",
  "omni.engine.redis": "plugins.names.redis",
  "omni.engine.kingbase": "plugins.names.kingbase",
  "omni.engine.vastbase": "plugins.names.vastbase",
  "omni.engine.uxdb": "plugins.names.uxdb",
  "omni.engine.oceanbase": "plugins.names.oceanbase",
  "omni.engine.oceanbase-oracle": "plugins.names.oceanbase",
  "omni.engine.dameng": "plugins.names.dameng",
  "omni.engine.oracle": "plugins.names.oracle",
  "omni.engine.hive": "plugins.names.hive",
  "omni.module.nacos": "plugins.names.nacos",
  "omni.addon.warpgate": "plugins.names.warpgate",
  "omni.importer.docker-db": "plugins.names.dockerDb",
  "omni.panel.1panel": "plugins.names.onepanel",
  "omni.panel.bt": "plugins.names.bt",
  "omni.panel.hestia": "plugins.names.hestia",
  "omni.theme.default": "plugins.names.themeDefault",
  "omni.addon.translator": "plugins.names.translator",
};

/** 无翻译时把 `omni.engine.kingbase` 收成可读短名，避免整段 id 上屏。 */
function humanizePluginId(id: string): string | null {
  const match = id.trim().match(/^omni\.[a-z]+\.(.+)$/i);
  if (!match?.[1]) return null;
  return titleCaseSegments(match[1]);
}

function titleCaseSegments(value: string): string {
  return value
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function pluginDisplayName(
  id: string,
  t: (key: string) => string,
  fallback?: string,
): string {
  const declared = getPluginManifest(id)?.displayName?.trim();
  if (declared) return declared;
  const key = PLUGIN_NAME_KEYS[id];
  if (key) return t(key);
  if (fallback?.trim() && fallback.trim() !== id) return fallback.trim();
  return humanizePluginId(id) ?? id;
}
