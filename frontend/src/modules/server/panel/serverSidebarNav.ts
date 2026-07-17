import type { ServerPanelDockOpenMode } from "./serverPanelWorkspaceTabs";

/** 详情区全部 Tab（含应用市场） */
export type ServerDetailTab = "apps" | "websites" | "certificates" | "cronjobs";

/** 侧栏可导航的资源分类（不含应用市场，应用市场仅在面板内 Tab） */
export type ServerSidebarResourceTab = Exclude<ServerDetailTab, "apps">;

export type ServerSidebarNavTarget = {
  serverId: string;
  detailTab?: ServerSidebarResourceTab;
  itemId?: string;
};

export type ServerSidebarNavigate = (
  target: ServerSidebarNavTarget,
  mode?: ServerPanelDockOpenMode,
) => void;
