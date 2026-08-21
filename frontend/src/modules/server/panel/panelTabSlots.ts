import { panel1PanelManifest } from "../../../../../plugins/panel-1panel/src/index";
import { panelBtManifest } from "../../../../../plugins/panel-bt/src/index";
import type { PluginManifest } from "@omnipanel/plugin-sdk";
import { isPluginActivated, usePluginRuntimeStore } from "../../../stores/pluginRuntimeStore";
import { canonicalPanelPluginId, PLUGIN_ID_PANEL_1PANEL, PLUGIN_ID_PANEL_BT } from "./panelPlugin";
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

const PANEL_MANIFESTS: Record<string, PluginManifest> = {
  [PLUGIN_ID_PANEL_1PANEL]: panel1PanelManifest,
  [PLUGIN_ID_PANEL_BT]: panelBtManifest,
};

function tabIdFromContribution(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const id = (raw as { id?: unknown }).id;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

export function listPanelPluginTabIds(serviceType: string | null | undefined): string[] {
  const pluginId = canonicalPanelPluginId(serviceType);
  const hydrated = usePluginRuntimeStore.getState().hydrated;
  if (hydrated && !isPluginActivated(pluginId)) return [];
  const manifest = PANEL_MANIFESTS[pluginId];
  const tabs = manifest?.contributes.ui?.panelTabs ?? [];
  return tabs.map(tabIdFromContribution).filter((id): id is string => Boolean(id));
}

export function listPanelDockTabs(serviceType: string | null | undefined): PanelDockTabId[] {
  const contributed = new Set(listPanelPluginTabIds(serviceType));
  return (Object.keys(PANEL_DOCK_TAB_SLOTS) as PanelDockTabId[]).filter((id) =>
    contributed.has(id),
  );
}
