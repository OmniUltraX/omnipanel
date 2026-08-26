import type { DbxCatalogDriver } from "../../../ipc/bindings";
import type { EngineDescriptor } from "../engineRegistry";

/** 对齐 DBX 连接选择器的引擎分组（不含队列 / 注册中心）。 */
export type EnginePickerCategoryKey =
  | "sql"
  | "analytics"
  | "domestic"
  | "lightweight"
  | "document"
  | "graph_ai"
  | "timeseries";

export type EnginePickerItem = {
  id: string;
  label: string;
  category: EnginePickerCategoryKey;
  available: boolean;
  catalogKey: string | null;
  pluginId: string | null;
  installedVersion: string | null;
  catalogVersion: string | null;
  needsUpgrade: boolean;
  /** 来自 DBX 目录（非第一方 inproc），芯片上显示 DBX 角标 */
  fromDbx: boolean;
  icon: string;
  defaultPort: number;
};

export const ENGINE_PICKER_CATEGORIES: ReadonlyArray<{
  key: EnginePickerCategoryKey;
  titleKey: string;
}> = [
  { key: "sql", titleKey: "database.dialog.categorySql" },
  { key: "analytics", titleKey: "database.dialog.categoryAnalytics" },
  { key: "domestic", titleKey: "database.dialog.categoryDomestic" },
  { key: "lightweight", titleKey: "database.dialog.categoryLightweight" },
  { key: "document", titleKey: "database.dialog.categoryDocument" },
  { key: "graph_ai", titleKey: "database.dialog.categoryGraphAi" },
  { key: "timeseries", titleKey: "database.dialog.categoryTimeseries" },
];

const ALIASES: Record<string, string> = {
  postgres: "postgresql",
  pg: "postgresql",
  mariadb: "mysql",
  mssql: "sqlserver",
  "sql server": "sqlserver",
  orcl: "oracle",
  dm: "dameng",
};

const FIRST_PARTY_LABELS: Record<string, string> = {
  mysql: "MySQL",
  postgresql: "PostgreSQL",
  sqlite: "SQLite",
  sqlserver: "SQL Server",
  redis: "Redis",
  mongodb: "MongoDB",
  qdrant: "Qdrant",
  clickhouse: "ClickHouse",
};

/** DBX CONNECTION_PICKER_OPTIONS 的分组，键已归一到 OmniPanel engine id。 */
const ENGINE_CATEGORY_BY_KEY: Record<string, EnginePickerCategoryKey> = {
  mysql: "sql",
  postgresql: "sql",
  sqlserver: "sql",
  oracle: "sql",
  firebird: "sql",
  cockroachdb: "sql",
  db2: "sql",
  informix: "sql",
  iris: "sql",
  spanner: "sql",
  clickhouse: "analytics",
  hive: "analytics",
  spark: "analytics",
  databend: "analytics",
  databricks: "analytics",
  exasol: "analytics",
  saphana: "analytics",
  snowflake: "analytics",
  teradata: "analytics",
  trino: "analytics",
  vertica: "analytics",
  kylin: "analytics",
  ignite: "analytics",
  ignite3: "analytics",
  dameng: "domestic",
  kingbase: "domestic",
  oceanbase: "domestic",
  "oceanbase-oracle": "domestic",
  highgo: "domestic",
  oscar: "domestic",
  vastbase: "domestic",
  xugu: "domestic",
  yashandb: "domestic",
  uxdb: "domestic",
  goldendb: "domestic",
  gbase8a: "domestic",
  gbase8s: "domestic",
  sqlite: "lightweight",
  access: "lightweight",
  h2: "lightweight",
  "h2-legacy": "lightweight",
  redis: "document",
  mongodb: "document",
  cassandra: "document",
  qdrant: "graph_ai",
  neo4j: "graph_ai",
  iotdb: "timeseries",
  tdengine: "timeseries",
};

export function canonicalPickerEngineId(raw: string): string {
  const key = raw.trim().toLowerCase();
  return ALIASES[key] ?? key;
}

export function categoryForEngine(raw: string): EnginePickerCategoryKey {
  const id = canonicalPickerEngineId(raw);
  return ENGINE_CATEGORY_BY_KEY[id] ?? "sql";
}

const FIRST_PARTY_IDS = new Set(Object.keys(FIRST_PARTY_LABELS));

function isFirstPartyEngine(id: string): boolean {
  return FIRST_PARTY_IDS.has(id);
}

function displayLabel(id: string, catalogLabel?: string): string {
  const fromCatalog = catalogLabel?.trim();
  if (fromCatalog) return fromCatalog;
  return FIRST_PARTY_LABELS[id] ?? id;
}

export function buildEnginePickerItems(
  descriptors: EngineDescriptor[],
  catalog: DbxCatalogDriver[],
): EnginePickerItem[] {
  const byId = new Map<string, EnginePickerItem>();

  for (const desc of descriptors) {
    if (!desc.supported) continue;
    const id = canonicalPickerEngineId(desc.id);
    byId.set(id, {
      id,
      label: displayLabel(id),
      category: categoryForEngine(id),
      available: true,
      catalogKey: null,
      pluginId: null,
      installedVersion: null,
      catalogVersion: null,
      needsUpgrade: false,
      fromDbx: !isFirstPartyEngine(id),
      icon: desc.icon,
      defaultPort: desc.defaultPort,
    });
  }

  for (const driver of catalog) {
    const id = canonicalPickerEngineId(driver.key);
    const existing = byId.get(id);
    if (existing) {
      existing.label = displayLabel(id, driver.label);
      existing.catalogKey = driver.key;
      existing.pluginId = driver.pluginId;
      existing.installedVersion = driver.installedVersion;
      existing.catalogVersion = driver.version;
      existing.needsUpgrade =
        existing.fromDbx &&
        engineNeedsUpgrade(driver.installed, driver.installedVersion, driver.version);
      if (driver.defaultPort > 0 && existing.defaultPort <= 0) {
        existing.defaultPort = driver.defaultPort;
      }
      continue;
    }
    byId.set(id, {
      id,
      label: displayLabel(id, driver.label),
      category: categoryForEngine(id),
      available: Boolean(driver.installed),
      catalogKey: driver.key,
      pluginId: driver.pluginId,
      installedVersion: driver.installedVersion,
      catalogVersion: driver.version,
      needsUpgrade: engineNeedsUpgrade(
        driver.installed,
        driver.installedVersion,
        driver.version,
      ),
      fromDbx: true,
      icon: id.slice(0, 2).toUpperCase(),
      defaultPort: driver.defaultPort,
    });
  }

  return [...byId.values()].sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1;
    return a.label.localeCompare(b.label, "zh-CN");
  });
}

export function categoriesWithItems(
  items: EnginePickerItem[],
): EnginePickerCategoryKey[] {
  const present = new Set(items.map((item) => item.category));
  return ENGINE_PICKER_CATEGORIES.map((c) => c.key).filter((key) => present.has(key));
}

export function engineNeedsUpgrade(
  installed: boolean,
  installedVersion: string | null | undefined,
  catalogVersion: string,
): boolean {
  return Boolean(
    installed && installedVersion && catalogVersion && installedVersion !== catalogVersion,
  );
}

export function isEngineInstalling(
  installingKey: string | null,
  catalogKey: string | null,
): boolean {
  return Boolean(installingKey) && installingKey === catalogKey;
}

export function filterPickerItems(
  items: EnginePickerItem[],
  category: EnginePickerCategoryKey,
  search: string,
): EnginePickerItem[] {
  const keyword = search.trim().toLowerCase();
  const scoped = keyword
    ? items
    : items.filter((item) => item.category === category);
  if (!keyword) return scoped;
  return scoped.filter((item) => {
    const hay = `${item.id} ${item.label} ${item.catalogKey ?? ""}`.toLowerCase();
    return hay.includes(keyword);
  });
}
