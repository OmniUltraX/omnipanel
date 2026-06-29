import { useCallback, useMemo, type ReactNode } from "react";
import { ModuleWorkspaceLayout } from "../../../components/workspace";
import { WorkspaceEmptyPage } from "../../../components/ui/WorkspaceEmptyPage";
import { useI18n } from "../../../i18n";
import type { ServerEntry } from "./serverConnection";
import type { useServerPanelWorkspace } from "./hooks/useServerPanelWorkspace";
import { ServerPanelSidebar } from "./ServerPanelSidebar";
import { ServerSidebarLinkageProvider } from "./ServerSidebarLinkageContext";
import type { ServerPanelDockOpenMode } from "./serverPanelWorkspaceTabs";

export type ServerPanelWorkspaceApi = ReturnType<typeof useServerPanelWorkspace>;

/** @deprecated 布局已上移至 ServerPanel */
export interface ServerPanelsWorkspaceViewProps {
  servers: ServerEntry[];
  workspace: ServerPanelWorkspaceApi;
  selectedServerId: string | null;
  onSelectServer: (serverId: string) => void;
  onSidebarSelectServer: (serverId: string, mode?: ServerPanelDockOpenMode) => void;
  onCreateServer: () => void;
  onEditServer?: (server: ServerEntry) => void;
  onDeleteServer?: (serverId: string) => void;
  panelContentKey?: string;
  renderServerPanel: (serverId: string, isActive: boolean) => ReactNode;
}

/** 服务器模块内层：左侧服务器列表 + 右侧单服务器面板。 */
export function ServerPanelsWorkspaceView({
  servers,
  workspace,
  selectedServerId,
  onSelectServer,
  onSidebarSelectServer,
  onCreateServer,
  onEditServer,
  onDeleteServer,
  renderServerPanel,
}: ServerPanelsWorkspaceViewProps) {
  const { t } = useI18n();
  const { activeServerId, handleSelectServer } = workspace;

  const resolvedServerId = activeServerId ?? selectedServerId;

  const sidebarLinkageValue = useMemo(
    () => ({
      activeServerId: resolvedServerId,
    }),
    [resolvedServerId],
  );

  const handleSidebarSelect = useCallback(
    (serverId: string, mode?: ServerPanelDockOpenMode) => {
      handleSelectServer(serverId, mode);
      onSidebarSelectServer(serverId, mode);
      onSelectServer(serverId);
    },
    [handleSelectServer, onSidebarSelectServer, onSelectServer],
  );

  return (
    <ServerSidebarLinkageProvider value={sidebarLinkageValue}>
      <ModuleWorkspaceLayout
        layoutKey="server-panels"
        className="server-panels-workspace"
        leftColumnTitle={t("routes.server")}
        leftPreset="server"
        leftSidebar={
          <ServerPanelSidebar
            servers={servers}
            onSelectServer={handleSidebarSelect}
            onCreateServer={onCreateServer}
            onEditServer={onEditServer}
            onDeleteServer={onDeleteServer}
          />
        }
      >
        {resolvedServerId ? (
          renderServerPanel(resolvedServerId, true)
        ) : (
          <WorkspaceEmptyPage
            title={t("routes.server")}
            prompt={t("server.empty.selectServer")}
          />
        )}
      </ModuleWorkspaceLayout>
    </ServerSidebarLinkageProvider>
  );
}
