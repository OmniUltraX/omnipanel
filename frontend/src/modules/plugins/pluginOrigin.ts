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
): PluginOrigin {
  if (item.source === "builtin" || officialIds.has(item.id)) return "official";
  if (dbxPluginIds.has(item.id)) return "thirdParty";
  return "local";
}

/** 当前第三方来源仅 DBX 目录引擎。 */
export function isDbxOrigin(origin: PluginOrigin): boolean {
  return origin === "thirdParty";
}

export function originLabelKey(origin: PluginOrigin): string {
  if (origin === "official") return "plugins.center.origin.official";
  if (origin === "thirdParty") return "plugins.center.origin.thirdParty";
  return "plugins.center.origin.local";
}

export function originMetaLabel(
  origin: PluginOrigin,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const base = t(originLabelKey(origin));
  if (isDbxOrigin(origin)) return `${base} · ${t("plugins.center.origin.dbx")}`;
  return base;
}
