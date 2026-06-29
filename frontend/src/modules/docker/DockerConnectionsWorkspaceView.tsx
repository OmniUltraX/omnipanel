import { useCallback, useMemo, type ReactNode } from "react";
import { ModuleWorkspaceLayout } from "../../components/workspace";
import { WorkspaceEmptyPage } from "../../components/ui/WorkspaceEmptyPage";
import { useI18n } from "../../i18n";
import type { DockerConnectionInfo } from "../../ipc/bindings";
import type { useDockerConnectionWorkspace } from "./hooks/useDockerConnectionWorkspace";
import { DockerConnectionSidebar } from "./DockerConnectionSidebar";
import { DockerSidebarLinkageProvider } from "./DockerSidebarLinkageContext";
import type { DockerConnectionDockOpenMode } from "./dockerConnectionWorkspaceTabs";

export type DockerConnectionWorkspaceApi = ReturnType<typeof useDockerConnectionWorkspace>;

/** @deprecated 布局已上移至 DockerPanel */
export interface DockerConnectionsWorkspaceViewProps {
  connections: DockerConnectionInfo[];
  workspace: DockerConnectionWorkspaceApi;
  connectionsLoading?: boolean;
  scanning?: boolean;
  selectedConnectionId: string | null;
  onSelectConnection: (connectionId: string) => void;
  onSidebarSelectConnection: (connectionId: string, mode?: DockerConnectionDockOpenMode) => void;
  onCreateConnection: () => void;
  onScan?: () => void;
  onEditConnection?: (connection: DockerConnectionInfo) => void;
  onDeleteConnection?: (connectionId: string) => void;
  panelContentKey?: string;
  renderConnectionPanel: (connectionId: string, isActive: boolean) => ReactNode;
}

/** Docker 模块内层：左侧连接树 + 右侧单连接面板（功能 Tab 由顶层 ModuleSegmentDock 提供）。 */
export function DockerConnectionsWorkspaceView({
  connections,
  workspace,
  connectionsLoading,
  scanning,
  selectedConnectionId,
  onSelectConnection,
  onSidebarSelectConnection,
  onCreateConnection,
  onScan,
  onEditConnection,
  onDeleteConnection,
  renderConnectionPanel,
}: DockerConnectionsWorkspaceViewProps) {
  const { t } = useI18n();
  const { activeConnectionId, handleSelectConnection } = workspace;

  const resolvedConnectionId = activeConnectionId ?? selectedConnectionId;

  const sidebarLinkageValue = useMemo(
    () => ({
      activeConnectionId: resolvedConnectionId,
    }),
    [resolvedConnectionId],
  );

  const handleSidebarSelect = useCallback(
    (connectionId: string, mode?: DockerConnectionDockOpenMode) => {
      handleSelectConnection(connectionId, mode);
      onSidebarSelectConnection(connectionId, mode);
      onSelectConnection(connectionId);
    },
    [handleSelectConnection, onSidebarSelectConnection, onSelectConnection],
  );

  return (
    <DockerSidebarLinkageProvider value={sidebarLinkageValue}>
      <ModuleWorkspaceLayout
        layoutKey="docker-connections"
        className="docker-connections-workspace"
        leftColumnTitle={t("routes.docker")}
        leftPreset="server"
        leftSidebar={
          <DockerConnectionSidebar
            connections={connections}
            loading={connectionsLoading}
            scanning={scanning}
            onSelectConnection={handleSidebarSelect}
            onCreate={onCreateConnection}
            onScan={onScan}
            onEditConnection={onEditConnection}
            onDeleteConnection={onDeleteConnection}
          />
        }
      >
        {resolvedConnectionId ? (
          renderConnectionPanel(resolvedConnectionId, true)
        ) : (
          <WorkspaceEmptyPage
            title={t("routes.docker")}
            prompt={t("docker.sidebar.selectConnection")}
          />
        )}
      </ModuleWorkspaceLayout>
    </DockerSidebarLinkageProvider>
  );
}
