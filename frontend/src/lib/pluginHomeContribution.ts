import type { PluginHomeContribution, PluginManifest } from "@omnipanel/plugin-sdk";
import type { PluginListItem } from "../ipc/bindings";
import { getPluginManifest } from "./pluginManifests";

export type EligibleHomePlugin = {
  pluginId: string;
  home: PluginHomeContribution;
};

export function parsePluginHomeContribution(
  manifest: PluginManifest | null,
): PluginHomeContribution | null {
  const home = manifest?.contributes.ui?.home;
  if (!home || home.show === false) return null;
  if (!home.open?.kind || !home.open.id.trim()) return null;
  return home;
}

export function listEligibleHomePlugins(items: PluginListItem[]): EligibleHomePlugin[] {
  const out: EligibleHomePlugin[] = [];
  for (const item of items) {
    if (!item.enabled || !item.activated) continue;
    const home = parsePluginHomeContribution(getPluginManifest(item.id));
    if (!home) continue;
    out.push({ pluginId: item.id, home });
  }
  return out;
}

export function listPinnedHomePlugins(
  items: PluginListItem[],
  hiddenIds: readonly string[],
  order: readonly string[],
): EligibleHomePlugin[] {
  const hidden = new Set(hiddenIds);
  const visible = listEligibleHomePlugins(items).filter((entry) => !hidden.has(entry.pluginId));
  if (order.length === 0) return visible;
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...visible].sort((a, b) => {
    const left = rank.get(a.pluginId) ?? Number.MAX_SAFE_INTEGER;
    const right = rank.get(b.pluginId) ?? Number.MAX_SAFE_INTEGER;
    if (left !== right) return left - right;
    return a.pluginId.localeCompare(b.pluginId);
  });
}
