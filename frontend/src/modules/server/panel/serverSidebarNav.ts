import type { ServerDetailTab } from "./ServerWorkspace";
import type { ServerPanelDockOpenMode } from "./serverPanelWorkspaceTabs";

export type ServerSidebarNavTarget = {
  serverId: string;
  detailTab?: ServerDetailTab;
  itemId?: string;
};

export type ServerSidebarNavigate = (
  target: ServerSidebarNavTarget,
  mode?: ServerPanelDockOpenMode,
) => void;
