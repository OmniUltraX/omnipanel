import { isPluginActivated, usePluginRuntimeStore } from "../../../stores/pluginRuntimeStore";
import { getPluginManifest, manifestPanelTabIds } from "../../../lib/pluginManifests";
import { canonicalPanelPluginId } from "./panelPlugin";

/** 第一方 Dock Tab id。未知 panelTabs id 仍会出现在 Dock，走通用壳。 */
export const PANEL_DOCK_TAB_IDS = [
  "apps",
  "websites",
  "certificates",
  "cronjobs",
  "databases",
] as const;

export type PanelDockTabId = (typeof PANEL_DOCK_TAB_IDS)[number];

/** 侧栏资源分类（不含应用市场，应用市场仅在面板内 Tab）。 */
export const PANEL_SIDEBAR_TAB_IDS = [
  "websites",
  "certificates",
  "cronjobs",
  "databases",
] as const satisfies readonly PanelDockTabId[];

export type PanelSidebarTabId = (typeof PANEL_SIDEBAR_TAB_IDS)[number];

export function listPanelPluginTabIds(serviceType: string | null | undefined): string[] {
  const pluginId = canonicalPanelPluginId(serviceType);
  const hydrated = usePluginRuntimeStore.getState().hydrated;
  if (hydrated && !isPluginActivated(pluginId)) return [];
  return manifestPanelTabIds(getPluginManifest(pluginId));
}

export function isFirstPartyPanelDockTab(id: string): id is PanelDockTabId {
  return (PANEL_DOCK_TAB_IDS as readonly string[]).includes(id);
}

/** 第一方已知槽用现有 React 页；其余清单 id 走通用壳。 */
export function resolvePanelDockKind(tabId: string): "first-party" | "generic" {
  return isFirstPartyPanelDockTab(tabId) ? "first-party" : "generic";
}

export function panelDockTabLabel(
  tabId: string,
  knownLabel: string | undefined,
  declLabel?: string,
): string {
  const custom = declLabel?.trim();
  if (custom) return custom;
  if (isFirstPartyPanelDockTab(tabId) && knownLabel) return knownLabel;
  return tabId;
}

export function listPanelDockTabs(serviceType: string | null | undefined): string[] {
  const contributed = listPanelPluginTabIds(serviceType);
  const contributedSet = new Set(contributed);
  const firstParty = PANEL_DOCK_TAB_IDS.filter((id) => contributedSet.has(id));
  const extra = contributed.filter((id) => id !== "overview" && !isFirstPartyPanelDockTab(id));
  return [...firstParty, ...extra];
}

export function listPanelSidebarTabs(serviceType: string | null | undefined): PanelSidebarTabId[] {
  const dock = new Set(listPanelDockTabs(serviceType));
  return PANEL_SIDEBAR_TAB_IDS.filter((id) => dock.has(id));
}
