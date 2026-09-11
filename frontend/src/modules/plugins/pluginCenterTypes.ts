import type { DbxCatalogDriver, MarketplaceItem, OfficialCatalogPlugin, PluginKind, PluginListItem, ResolvePlan } from "../../ipc/bindings";
import type { PluginOrigin } from "./pluginOrigin";

export type KindFilter = PluginKind | "all";
/** 市场来源过滤：全部 / 官方 / 各来源 id 直列（dbx、rubick、自定义源…）。 */
export type MarketFilter = "all" | "official" | "thirdParty" | (string & {});
export type MarketView = "list" | "grid";
export type MarketSortKey =
  | "name"
  | "kind"
  | "origin"
  | "version"
  | "size"
  | "created"
  | "updated"
  | "downloads";
export type MarketSortDir = "asc" | "desc";

export const MARKET_SORT_KEYS: MarketSortKey[] = [
  "updated",
  "created",
  "name",
  "kind",
  "origin",
  "version",
  "size",
  "downloads",
];

export const MARKET_SORT_DEFAULT_DIR: Record<MarketSortKey, MarketSortDir> = {
  name: "asc",
  kind: "asc",
  origin: "asc",
  version: "desc",
  size: "desc",
  created: "desc",
  updated: "desc",
  downloads: "desc",
};

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
  createdAt: string | null;
  updatedAt: string | null;
  /** GitHub Release asset 下载次数；bundled 通常为 null。 */
  downloads: number | null;
  /** 本机成功安装 / 更新次数。 */
  localInstalls: number;
  changelog: string | null;
  sourceId: string | null;
  /** 外部来源包名（Rubick npm 名）；官方/内置为空，转换安装用。 */
  externalNpm: string | null;
};

function optionalStamp(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

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
    createdAt: optionalStamp(plugin.createdAt),
    updatedAt: optionalStamp(plugin.updatedAt),
    downloads: plugin.downloads ?? null,
    localInstalls: 0,
    changelog: null,
    sourceId: "official",
    externalNpm: null,
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
    createdAt: optionalStamp(driver.createdAt),
    updatedAt: optionalStamp(driver.updatedAt),
    downloads: driver.downloads ?? null,
    localInstalls: 0,
    changelog: null,
    sourceId: "dbx",
    externalNpm: null,
  };
}

export function marketplaceToMarketItem(item: MarketplaceItem, name: string): MarketItem {
  const official = item.sourceId === "official";
  return {
    id: item.id,
    name,
    kind: item.kind,
    version: item.version,
    origin: official ? "official" : "thirdParty",
    distribution: item.downloadSize > 0 ? "download" : "bundled",
    installed: item.installed,
    installedVersion: item.installedVersion ?? null,
    size: item.downloadSize,
    artifactKind: null,
    dbxKey: null,
    description: item.description,
    permissions: item.permissions,
    needsUpdate: item.updateAvailable,
    createdAt: null,
    updatedAt: null,
    downloads: null,
    localInstalls: 0,
    changelog: item.changelog ?? null,
    sourceId: item.sourceId,
    externalNpm: item.externalNpm ?? null,
  };
}

export function shouldConfirmInstallPlan(plan: ResolvePlan, targetId: string): boolean {
  return plan.warnings.length > 0 || plan.items.some((step) => step.id !== targetId);
}

export function withLocalStats(
  item: MarketItem,
  stats: { installs: number },
): MarketItem {
  return {
    ...item,
    localInstalls: stats.installs,
  };
}

export function stampMs(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export function effectiveDownloads(item: MarketItem): number | null {
  if (item.downloads != null && item.downloads > 0) return item.downloads;
  if (item.localInstalls > 0) return item.localInstalls;
  return null;
}

function cmpNullableNumber(a: number | null, b: number | null, dir: MarketSortDir): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return dir === "asc" ? a - b : b - a;
}

function cmpString(a: string, b: string, dir: MarketSortDir): number {
  const result = a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  return dir === "asc" ? result : -result;
}

export function sortMarketItems(
  items: MarketItem[],
  key: MarketSortKey,
  dir: MarketSortDir,
): MarketItem[] {
  const next = [...items];
  next.sort((left, right) => {
    let result = 0;
    switch (key) {
      case "name":
        result = cmpString(left.name, right.name, dir);
        break;
      case "kind":
        result = cmpString(left.kind, right.kind, dir);
        break;
      case "origin":
        result = cmpString(left.origin, right.origin, dir);
        break;
      case "version":
        result = cmpString(left.version, right.version, dir);
        break;
      case "size":
        result = cmpNullableNumber(left.size || null, right.size || null, dir);
        break;
      case "created":
        result = cmpNullableNumber(stampMs(left.createdAt), stampMs(right.createdAt), dir);
        break;
      case "updated":
        result = cmpNullableNumber(stampMs(left.updatedAt), stampMs(right.updatedAt), dir);
        break;
      case "downloads":
        result = cmpNullableNumber(effectiveDownloads(left), effectiveDownloads(right), dir);
        break;
    }
    if (result !== 0) return result;
    return left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) || left.id.localeCompare(right.id);
  });
  return next;
}

export function formatPluginDate(iso: string | null, locale: string): string {
  const ms = stampMs(iso);
  if (ms == null) return "";
  return new Date(ms).toLocaleDateString(locale === "zh-CN" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

export function formatPluginCount(value: number): string {
  if (value >= 1_000_000) {
    const n = value / 1_000_000;
    return `${n >= 10 ? n.toFixed(0) : n.toFixed(1)}M`;
  }
  if (value >= 1000) {
    const n = value / 1000;
    return `${n >= 10 ? n.toFixed(0) : n.toFixed(1)}k`;
  }
  return String(value);
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

/**
 * npm 包名 → 外部插件 id 后缀（与后端 sanitize_external_id 同构，
 * 已安装判定依赖两者一致；不一致最多导致重复条目，不会导致误装）。
 */
export function sanitizeExternalId(name: string): string {
  let out = "";
  for (const c of name.toLowerCase()) {
    if (/[a-z0-9._-]/.test(c)) out += c;
    else if (!out.endsWith("-")) out += "-";
  }
  out = out.replace(/^[-.]+|[-.]+$/g, "");
  return out || "external";
}
