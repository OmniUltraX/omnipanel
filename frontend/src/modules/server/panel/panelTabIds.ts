import { isPluginActivated, usePluginRuntimeStore } from "../../../stores/pluginRuntimeStore";
import { getPluginManifest, manifestPanelTabIds } from "../../../lib/pluginManifests";
import { canonicalPanelPluginId } from "./panelPlugin";

/** 宿主已实现的 Dock Tab id。插件只能点名这些 id。 */
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

export function listPanelDockTabs(serviceType: string | null | undefined): PanelDockTabId[] {
  const contributed = new Set(listPanelPluginTabIds(serviceType));
  return PANEL_DOCK_TAB_IDS.filter((id) => contributed.has(id));
}

export function listPanelSidebarTabs(serviceType: string | null | undefined): PanelSidebarTabId[] {
  const dock = new Set(listPanelDockTabs(serviceType));
  return PANEL_SIDEBAR_TAB_IDS.filter((id) => dock.has(id));
}
