import type { PluginListItem } from "../../ipc/bindings";
import { FIRST_PARTY_PLUGIN_MANIFESTS } from "../../lib/pluginManifests";

export type PluginOrigin = "official" | "thirdParty" | "local";

export function firstPartyIdSet(): Set<string> {
  return new Set(FIRST_PARTY_PLUGIN_MANIFESTS.map((item) => item.id));
}

export function originForInstalled(
  item: PluginListItem,
  officialIds: ReadonlySet<string>,
  dbxPluginIds: ReadonlySet<string>,
  registryThirdPartyIds: ReadonlySet<string> = new Set(),
): PluginOrigin {
  if (item.source === "builtin" || officialIds.has(item.id)) return "official";
  if (dbxPluginIds.has(item.id) || registryThirdPartyIds.has(item.id)) return "thirdParty";
  return "local";
}

export function isDbxCatalog(id: string, dbxPluginIds: ReadonlySet<string>): boolean {
  return dbxPluginIds.has(id);
}

/** 仅 DBX 目录引擎；自定义 registry 第三方不算 DBX。 */
export function isDbxOrigin(
  origin: PluginOrigin,
  dbx = false,
): boolean {
  return origin === "thirdParty" && dbx;
}

export function originLabelKey(origin: PluginOrigin): string {
  if (origin === "official") return "plugins.center.origin.official";
  if (origin === "thirdParty") return "plugins.center.origin.thirdParty";
  return "plugins.center.origin.local";
}

export function originMetaLabel(
  origin: PluginOrigin,
  t: (key: string, params?: Record<string, string | number>) => string,
  opts?: { dbx?: boolean; rubick?: boolean },
): string {
  const base = t(originLabelKey(origin));
  if (opts?.dbx) return `${base} · ${t("plugins.center.origin.dbx")}`;
  if (opts?.rubick) return `${base} · ${t("plugins.center.origin.rubick")}`;
  return base;
}
