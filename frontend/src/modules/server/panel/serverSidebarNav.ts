import type { ServerPanelDockOpenMode } from "./serverPanelWorkspaceTabs";

/** 侧栏导航 / 详情 Tab：网站、证书、计划任务 */
export type ServerDetailTab = "websites" | "certificates" | "cronjobs";

export type ServerSidebarNavTarget = {
  serverId: string;
  detailTab?: ServerDetailTab;
  itemId?: string;
};

export type ServerSidebarNavigate = (
  target: ServerSidebarNavTarget,
  mode?: ServerPanelDockOpenMode,
) => void;
