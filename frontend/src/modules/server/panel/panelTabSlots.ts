import { ServerAppsTab } from "./tabs/ServerAppsTab";
import { ServerCertificatesTab } from "./tabs/ServerCertificatesTab";
import { ServerCronjobsTab } from "./tabs/ServerCronjobsTab";
import { ServerDatabasesTab } from "./tabs/ServerDatabasesTab";
import { ServerWebsitesTab } from "./tabs/ServerWebsitesTab";

export type { PanelDockTabId, PanelSidebarTabId } from "./panelTabIds";
export {
  PANEL_DOCK_TAB_IDS,
  PANEL_SIDEBAR_TAB_IDS as PANEL_SIDEBAR_TAB_SLOTS,
  isFirstPartyPanelDockTab,
  listPanelDockTabs,
  listPanelPluginTabIds,
  listPanelSidebarTabs,
  resolvePanelDockKind,
} from "./panelTabIds";

/** 第一方 Dock Tab 的 React 页。未知 panelTabs id 走 GenericPanelTabPane。 */
export const PANEL_DOCK_TAB_SLOTS = {
  apps: ServerAppsTab,
  websites: ServerWebsitesTab,
  certificates: ServerCertificatesTab,
  cronjobs: ServerCronjobsTab,
  databases: ServerDatabasesTab,
} as const;
