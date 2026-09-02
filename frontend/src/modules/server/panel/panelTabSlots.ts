import { ServerAppsTab } from "./tabs/ServerAppsTab";
import { ServerCertificatesTab } from "./tabs/ServerCertificatesTab";
import { ServerCronjobsTab } from "./tabs/ServerCronjobsTab";
import { ServerDatabasesTab } from "./tabs/ServerDatabasesTab";
import { ServerWebsitesTab } from "./tabs/ServerWebsitesTab";

export type { PanelDockTabId, PanelSidebarTabId } from "./panelTabIds";
export {
  PANEL_DOCK_TAB_IDS,
  PANEL_SIDEBAR_TAB_IDS as PANEL_SIDEBAR_TAB_SLOTS,
  listPanelDockTabs,
  listPanelPluginTabIds,
  listPanelSidebarTabs,
} from "./panelTabIds";

/** Panel Host 已实现的 Tab 插槽。插件只能点名这些 id，不能自带 React。 */
export const PANEL_DOCK_TAB_SLOTS = {
  apps: ServerAppsTab,
  websites: ServerWebsitesTab,
  certificates: ServerCertificatesTab,
  cronjobs: ServerCronjobsTab,
  databases: ServerDatabasesTab,
} as const;
