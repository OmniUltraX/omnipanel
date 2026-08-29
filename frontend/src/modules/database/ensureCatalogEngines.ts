import { commands, type DbxCatalogDriver, type PluginListItem } from "../../ipc/bindings";
import { formatIpcError, unwrapCommand } from "../../ipc/result";
import { useDbxCatalogStore } from "../../stores/dbxCatalogStore";
import { usePluginRuntimeStore } from "../../stores/pluginRuntimeStore";
import { isEngineReady } from "./engineRegistry";

/** 每组按目录实有 key 解析；官方 registry 当前无 gaussdb / tidb，OceanBase 只有 oceanbase-oracle。 */
export const CATALOG_ENGINE_GROUPS: readonly (readonly string[])[] = [
  ["kingbase"],
  ["vastbase"],
  ["uxdb"],
  ["gaussdb", "opengauss"],
  ["oceanbase", "oceanbase-oracle"],
  ["tidb"],
];

const DB_TYPE_ALIASES: Record<string, readonly string[]> = {
  mysql: ["mysql", "mariadb"],
  mariadb: ["mysql", "mariadb"],
  postgresql: ["postgresql", "postgres", "pg"],
  postgres: ["postgresql", "postgres", "pg"],
  pg: ["postgresql", "postgres", "pg"],
  redis: ["redis"],
  mongodb: ["mongodb", "mongo"],
  mongo: ["mongodb", "mongo"],
  clickhouse: ["clickhouse"],
  sqlserver: ["sqlserver", "mssql"],
  mssql: ["sqlserver", "mssql"],
  sqlite: ["sqlite", "sqlite3"],
  qdrant: ["qdrant"],
  dameng: ["dameng", "dm"],
  dm: ["dameng", "dm"],
  cassandra: ["cassandra"],
  neo4j: ["neo4j"],
  kingbase: ["kingbase"],
  vastbase: ["vastbase"],
  uxdb: ["uxdb"],
  gaussdb: ["gaussdb", "opengauss"],
  opengauss: ["gaussdb", "opengauss"],
  oceanbase: ["oceanbase", "oceanbase-oracle"],
  "oceanbase-oracle": ["oceanbase", "oceanbase-oracle"],
  tidb: ["tidb"],
};

export type EnsureEngineResult =
  | { status: "ready" }
  | { status: "enabled"; pluginId: string }
  | { status: "installed"; key: string; label: string }
  | { status: "unavailable"; dbType: string }
  | { status: "error"; message: string };

export function resolveCatalogEngineKey(
  available: Iterable<string>,
  aliases: readonly string[],
): string | undefined {
  const have = available instanceof Set ? available : new Set(available);
  return aliases.find((key) => have.has(key));
}

export function catalogAliasesForDbType(dbType: string): string[] {
  const key = dbType.trim().toLowerCase();
  if (!key) return [];
  const mapped = DB_TYPE_ALIASES[key] ?? [key];
  const fromGroups = CATALOG_ENGINE_GROUPS.find((group) => group.includes(key));
  return [...new Set([...mapped, ...(fromGroups ?? [])])];
}

function pluginMatchesDbType(item: PluginListItem, aliases: readonly string[]): boolean {
  if (item.kind !== "engine") return false;
  const idKey = item.id.replace(/^omni\.engine\./, "");
  return aliases.includes(idKey) || aliases.includes(item.id);
}

function driverMatchesDbType(driver: DbxCatalogDriver, aliases: readonly string[]): boolean {
  const idKey = driver.pluginId.replace(/^omni\.engine\./, "");
  return aliases.includes(driver.key) || aliases.includes(idKey);
}

const engineInFlight = new Map<string, Promise<EnsureEngineResult>>();

async function loadCatalogDrivers(): Promise<DbxCatalogDriver[]> {
  const store = useDbxCatalogStore.getState();
  if (store.drivers.length === 0) await store.refresh();
  return useDbxCatalogStore.getState().drivers;
}

/** 打开导入/同步连接时：已装则启用，未装则从 DBX 目录下载对应引擎。 */
export function ensureEngineForDbType(dbType: string): Promise<EnsureEngineResult> {
  const key = dbType.trim().toLowerCase();
  if (!key) return Promise.resolve({ status: "unavailable", dbType });
  const existing = engineInFlight.get(key);
  if (existing) return existing;
  const run = (async (): Promise<EnsureEngineResult> => {
    if (isEngineReady(key)) return { status: "ready" };
    const aliases = catalogAliasesForDbType(key);
    let items: PluginListItem[] = [];
    try {
      items = await unwrapCommand(commands.pluginList(), { quiet: true });
    } catch (err) {
      return { status: "error", message: formatIpcError(err) };
    }
    const plugin = items.find((item) => pluginMatchesDbType(item, aliases));
    if (plugin) {
      if (plugin.enabled && plugin.activated) return { status: "ready" };
      try {
        await unwrapCommand(commands.pluginSetEnabled(plugin.id, true));
        await usePluginRuntimeStore.getState().reload();
        return { status: "enabled", pluginId: plugin.id };
      } catch (err) {
        return { status: "error", message: formatIpcError(err) };
      }
    }
    let driver: DbxCatalogDriver | undefined;
    try {
      const catalog = await loadCatalogDrivers();
      driver = catalog.find((item) => driverMatchesDbType(item, aliases));
    } catch (err) {
      return { status: "error", message: formatIpcError(err) };
    }
    if (!driver) return { status: "unavailable", dbType: key };
    if (driver.installed) {
      try {
        await unwrapCommand(commands.pluginSetEnabled(driver.pluginId, true));
        await usePluginRuntimeStore.getState().reload();
        return { status: "enabled", pluginId: driver.pluginId };
      } catch (err) {
        return { status: "error", message: formatIpcError(err) };
      }
    }
    try {
      await unwrapCommand(commands.pluginDbxInstall(driver.key));
      await usePluginRuntimeStore.getState().reload();
      await useDbxCatalogStore.getState().refresh();
      return { status: "installed", key: driver.key, label: driver.label };
    } catch (err) {
      return { status: "error", message: formatIpcError(err) };
    }
  })().finally(() => {
    engineInFlight.delete(key);
  });
  engineInFlight.set(key, run);
  return run;
}

let inFlight: Promise<void> | null = null;

/** 安装金仓 / Vastbase / UXDB / OceanBase 等；目录无包则跳过，不发 IPC 安装。 */
export function ensureCatalogEngines(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    let list: { id: string }[] = [];
    try {
      list = await unwrapCommand(commands.pluginList(), { quiet: true });
    } catch {
      inFlight = null;
      return;
    }
    const have = new Set(list.map((item) => item.id));

    let catalogKeys: Set<string>;
    try {
      const catalog = await unwrapCommand(commands.pluginDbxCatalog(), { quiet: true });
      catalogKeys = new Set(catalog.map((item) => item.key));
    } catch (err) {
      console.warn("[dbx] 拉取目录失败，跳过可选引擎安装:", err);
      inFlight = null;
      return;
    }

    for (const aliases of CATALOG_ENGINE_GROUPS) {
      const key = resolveCatalogEngineKey(catalogKeys, aliases);
      if (!key) {
        console.warn(`[dbx] 目录无包，跳过 ${aliases.join("/")}`);
        continue;
      }
      const id = `omni.engine.${key}`;
      if (have.has(id)) continue;
      try {
        await unwrapCommand(commands.pluginDbxInstall(key), { quiet: true });
        have.add(id);
      } catch (err) {
        console.warn(`[dbx] 跳过安装 ${key}:`, err);
      }
    }
  })();
  return inFlight;
}
