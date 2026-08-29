const PLUGIN_ID_EVERYTHING = "omni.addon.everything";

const PLUGIN_NAME_KEYS: Record<string, string> = {
  [PLUGIN_ID_EVERYTHING]: "plugins.names.everything",
  "omni.cloud.aliyun": "plugins.names.aliyun",
  "omni.engine.qdrant": "plugins.names.qdrant",
  "omni.engine.clickhouse": "plugins.names.clickhouse",
  "omni.engine.mongodb": "plugins.names.mongodb",
  "omni.engine.mysql": "plugins.names.mysql",
  "omni.engine.postgres": "plugins.names.postgres",
  "omni.engine.sqlite": "plugins.names.sqlite",
  "omni.engine.sqlserver": "plugins.names.sqlserver",
  "omni.engine.redis": "plugins.names.redis",
  "omni.module.nacos": "plugins.names.nacos",
  "omni.importer.warpgate": "plugins.names.warpgate",
  "omni.importer.docker-db": "plugins.names.dockerDb",
  "omni.panel.1panel": "plugins.names.onepanel",
  "omni.panel.bt": "plugins.names.bt",
  "omni.theme.default": "plugins.names.themeDefault",
  "omni.addon.translator": "plugins.names.translator",
};

export function pluginDisplayName(
  id: string,
  t: (key: string) => string,
  fallback?: string,
): string {
  const key = PLUGIN_NAME_KEYS[id];
  if (key) return t(key);
  if (fallback?.trim()) return fallback;
  return id;
}
