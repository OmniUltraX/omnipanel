import type { DbxCatalogDriver, OfficialCatalogPlugin, PluginKind, PluginListItem } from "../../ipc/bindings";
import type { PluginOrigin } from "./pluginOrigin";

export type KindFilter = PluginKind | "all";
export type MarketFilter = "all" | "official" | "thirdParty";
export type MarketView = "list" | "grid";

export const MARKET_PAGE_SIZE_DEFAULT = 40;
export const MARKET_PAGE_SIZE_OPTIONS = [20, 40, 60, 80, 100] as const;

export const DETAIL_HEIGHT_DEFAULT = 280;
export const DETAIL_HEIGHT_MIN = 160;

export function paginateItems<T>(
  items: T[],
  page: number,
  pageSize: number,
): { page: number; totalPages: number; slice: T[]; from: number; to: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize) || 1);
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * pageSize;
  const slice = items.slice(start, start + pageSize);
  return {
    page: safePage,
    totalPages,
    slice,
    from: items.length === 0 ? 0 : start + 1,
    to: start + slice.length,
  };
}

export const KIND_FILTERS: KindFilter[] = [
  "all",
  "engine",
  "importer",
  "panel",
  "cloud",
  "module",
  "theme",
  "addon",
];

export const KIND_ORDER: PluginKind[] = [
  "engine",
  "importer",
  "panel",
  "cloud",
  "module",
  "theme",
  "addon",
];

export type MarketItem = {
  id: string;
  name: string;
  kind: PluginKind;
  version: string;
  origin: PluginOrigin;
  distribution: OfficialCatalogPlugin["distribution"] | null;
  installed: boolean;
  installedVersion: string | null;
  size: number;
  artifactKind: string | null;
  dbxKey: string | null;
  description: string;
  permissions: string[];
  needsUpdate: boolean;
};

export function officialToMarketItem(
  plugin: OfficialCatalogPlugin,
  name: string,
): MarketItem {
  const needsUpdate =
    plugin.installed &&
    plugin.installedVersion != null &&
    plugin.installedVersion !== plugin.version &&
    plugin.distribution === "download";
  return {
    id: plugin.id,
    name,
    kind: plugin.kind,
    version: plugin.version,
    origin: "official",
    distribution: plugin.distribution,
    installed: plugin.installed,
    installedVersion: plugin.installedVersion,
    size: plugin.size,
    artifactKind: null,
    dbxKey: null,
    description: plugin.description,
    permissions: plugin.permissions,
    needsUpdate,
  };
}

export function dbxToMarketItem(driver: DbxCatalogDriver, name: string): MarketItem {
  const needsUpdate =
    driver.installed &&
    driver.installedVersion != null &&
    driver.installedVersion !== driver.version;
  return {
    id: driver.pluginId,
    name,
    kind: "engine",
    version: driver.version,
    origin: "thirdParty",
    distribution: "download",
    installed: driver.installed,
    installedVersion: driver.installedVersion,
    size: driver.size,
    artifactKind: driver.artifactKind,
    dbxKey: driver.key,
    description: "",
    permissions: ["net:connect"],
    needsUpdate,
  };
}

export function groupInstalledByKind(items: PluginListItem[]): { kind: PluginKind; items: PluginListItem[] }[] {
  const buckets = new Map<PluginKind, PluginListItem[]>();
  for (const kind of KIND_ORDER) buckets.set(kind, []);
  for (const item of items) {
    const list = buckets.get(item.kind) ?? [];
    list.push(item);
    buckets.set(item.kind, list);
  }
  return KIND_ORDER.map((kind) => ({
    kind,
    items: buckets.get(kind) ?? [],
  })).filter((group) => group.items.length > 0);
}

export function groupMarketByKind(items: MarketItem[]): { kind: PluginKind; items: MarketItem[] }[] {
  const buckets = new Map<PluginKind, MarketItem[]>();
  for (const kind of KIND_ORDER) buckets.set(kind, []);
  for (const item of items) {
    const list = buckets.get(item.kind) ?? [];
    list.push(item);
    buckets.set(item.kind, list);
  }
  return KIND_ORDER.map((kind) => ({
    kind,
    items: buckets.get(kind) ?? [],
  })).filter((group) => group.items.length > 0);
}

export function pluginMatchesQuery(
  id: string,
  name: string,
  kind: string,
  query: string,
): boolean {
  if (!query) return true;
  return (
    name.toLowerCase().includes(query) ||
    id.toLowerCase().includes(query) ||
    kind.includes(query)
  );
}

export function formatPluginSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes > 0) return `${bytes} B`;
  return "";
}
