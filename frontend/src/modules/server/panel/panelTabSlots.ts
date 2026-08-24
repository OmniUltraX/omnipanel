import { isPluginActivated, usePluginRuntimeStore } from "../../../stores/pluginRuntimeStore";
import { canonicalPanelPluginId } from "./panelPlugin";
import { getPluginManifest, manifestPanelTabIds } from "../../../lib/pluginManifests";
import { ServerAppsTab } from "./tabs/ServerAppsTab";
import { ServerCertificatesTab } from "./tabs/ServerCertificatesTab";
import { ServerCronjobsTab } from "./tabs/ServerCronjobsTab";
import { ServerWebsitesTab } from "./tabs/ServerWebsitesTab";

/** Panel Host 已实现的 Tab 插槽。插件只能点名这些 id，不能自带 React。 */
export const PANEL_DOCK_TAB_SLOTS = {
  apps: ServerAppsTab,
  websites: ServerWebsitesTab,
  certificates: ServerCertificatesTab,
  cronjobs: ServerCronjobsTab,
} as const;

export type PanelDockTabId = keyof typeof PANEL_DOCK_TAB_SLOTS;

export function listPanelPluginTabIds(serviceType: string | null | undefined): string[] {
  const pluginId = canonicalPanelPluginId(serviceType);
  const hydrated = usePluginRuntimeStore.getState().hydrated;
  if (hydrated && !isPluginActivated(pluginId)) return [];
  return manifestPanelTabIds(getPluginManifest(pluginId));
}

export function listPanelDockTabs(serviceType: string | null | undefined): PanelDockTabId[] {
  const contributed = new Set(listPanelPluginTabIds(serviceType));
  return (Object.keys(PANEL_DOCK_TAB_SLOTS) as PanelDockTabId[]).filter((id) =>
    contributed.has(id),
  );
}
