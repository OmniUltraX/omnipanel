import { useCallback, useMemo, useRef, type ReactNode } from "react";
import { DockWorkspace } from "../../components/dock";
import { usePanelLayoutStore } from "../../stores/panelLayoutStore";
import { useI18n } from "../../i18n";
import type { DockerConnectionInfo } from "../../ipc/bindings";
import type { useDockerConnectionWorkspace } from "./hooks/useDockerConnectionWorkspace";
import { DockerConnectionSidebar } from "./DockerConnectionSidebar";
import { DockerSidebarLinkageProvider } from "./DockerSidebarLinkageContext";
import { DockerWorkspaceDock } from "./DockerWorkspaceDock";
import type { DockerConnectionDockOpenMode } from "./dockerConnectionWorkspaceTabs";

const LEFT_MIN_PX = 200;
const LAYOUT_PERSIST_KEY = "docker-connections";

export type DockerConnectionWorkspaceApi = ReturnType<typeof useDockerConnectionWorkspace>;

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
  renderConnectionPanel: (connectionId: string, dockTabId: string, isActive: boolean) => ReactNode;
}

/** Docker 模块内层：左侧连接树 + 右侧连接 Dock（由顶层 ModuleSegmentDock 包裹）。 */
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
  panelContentKey,
  renderConnectionPanel,
}: DockerConnectionsWorkspaceViewProps) {
  const { t } = useI18n();
  const {
    workspaceTabs,
    activeTabId,
    activeConnectionId,
    dockTabs,
    dockLayout,
    setDockLayout,
    activateTab,
    handleSelectConnection,
    handleCloseTab,
    handleDockTabDoubleClick,
  } = workspace;

  const savedSize = usePanelLayoutStore((s) => s.leftSizes[LAYOUT_PERSIST_KEY]);
  const setLeftSize = usePanelLayoutStore((s) => s.setLeftSize);
  const leftSizePx =
    typeof savedSize === "number" && savedSize >= LEFT_MIN_PX ? savedSize : undefined;
  const pendingLeftSizeRef = useRef<number | null>(null);

  const handleLeftResize = useCallback((sizePx: number) => {
    pendingLeftSizeRef.current = sizePx;
  }, []);

  const handleLeftLayoutChanged = useCallback(() => {
    const size = pendingLeftSizeRef.current;
    if (size == null) return;
    if (size < LEFT_MIN_PX) {
      pendingLeftSizeRef.current = null;
      return;
    }
    setLeftSize(LAYOUT_PERSIST_KEY, size);
    pendingLeftSizeRef.current = null;
  }, [setLeftSize]);

  const sidebarLinkageValue = useMemo(
    () => ({
      activeConnectionId: activeConnectionId ?? selectedConnectionId,
    }),
    [activeConnectionId, selectedConnectionId],
  );

  const handleSidebarSelect = useCallback(
    (connectionId: string, mode?: DockerConnectionDockOpenMode) => {
      handleSelectConnection(connectionId, mode);
      onSidebarSelectConnection(connectionId, mode);
    },
    [handleSelectConnection, onSidebarSelectConnection],
  );

  const handleActiveTabChange = useCallback(
    (tabId: string) => {
      activateTab(tabId);
      const tab = workspaceTabs.find((item) => item.id === tabId);
      if (tab) {
        onSelectConnection(tab.connectionId);
      }
    },
    [activateTab, workspaceTabs, onSelectConnection],
  );

  const handleCloseDockTab = useCallback(
    (tabId: string) => {
      const closingIndex = workspaceTabs.findIndex((item) => item.id === tabId);
      const nextTabs = workspaceTabs.filter((item) => item.id !== tabId);
      const wasActive = activeTabId === tabId;
      handleCloseTab(tabId);
      if (wasActive && nextTabs.length > 0) {
        const fallback = nextTabs[Math.min(closingIndex, nextTabs.length - 1)];
        onSelectConnection(fallback.connectionId);
      }
    },
    [handleCloseTab, workspaceTabs, activeTabId, onSelectConnection],
  );

  const renderDockPanel = useCallback(
    (tabId: string) => {
      const tab = workspaceTabs.find((item) => item.id === tabId);
      if (!tab) return null;
      const isActive = tabId === activeTabId;
      return renderConnectionPanel(tab.connectionId, tabId, isActive);
    },
    [workspaceTabs, activeTabId, renderConnectionPanel],
  );

  return (
    <DockerSidebarLinkageProvider value={sidebarLinkageValue}>
      <DockWorkspace
        className="docker-connections-workspace"
        leftPreset="server"
        leftSizePx={leftSizePx}
        leftMinPx={LEFT_MIN_PX}
        onLeftResize={handleLeftResize}
        onLeftLayoutChanged={handleLeftLayoutChanged}
        left={
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
        main={
          <DockerWorkspaceDock
            dockTabs={dockTabs}
            activeTabId={activeTabId}
            onActiveTabChange={handleActiveTabChange}
            onCloseTab={handleCloseDockTab}
            dockLayout={dockLayout}
            onDockLayoutChange={setDockLayout}
            renderDockPanel={renderDockPanel}
            onTabDoubleClick={handleDockTabDoubleClick}
            panelContentKey={panelContentKey}
            emptyPrompt={t("docker.sidebar.selectConnection")}
          />
        }
      />
    </DockerSidebarLinkageProvider>
  );
}
