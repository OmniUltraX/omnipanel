import { useCallback, useMemo, useRef, type ReactNode } from "react";
import { DockWorkspace } from "../../../components/dock";
import { usePanelLayoutStore } from "../../../stores/panelLayoutStore";
import { useI18n } from "../../../i18n";
import type { ServerEntry } from "./serverConnection";
import type { useServerPanelWorkspace } from "./hooks/useServerPanelWorkspace";
import { ServerPanelSidebar } from "./ServerPanelSidebar";
import { ServerSidebarLinkageProvider } from "./ServerSidebarLinkageContext";
import { ServerWorkspaceDock } from "./ServerWorkspaceDock";
import type { ServerPanelDockOpenMode } from "./serverPanelWorkspaceTabs";

const LEFT_MIN_PX = 200;
const LAYOUT_PERSIST_KEY = "server-panels";

export type ServerPanelWorkspaceApi = ReturnType<typeof useServerPanelWorkspace>;

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
  renderServerPanel: (serverId: string, dockTabId: string, isActive: boolean) => ReactNode;
}

/** 服务器模块内层：左侧服务器列表 + 右侧面板 Dock（由顶层 ModuleSegmentDock 包裹）。 */
export function ServerPanelsWorkspaceView({
  servers,
  workspace,
  selectedServerId,
  onSelectServer,
  onSidebarSelectServer,
  onCreateServer,
  onEditServer,
  onDeleteServer,
  panelContentKey,
  renderServerPanel,
}: ServerPanelsWorkspaceViewProps) {
  const { t } = useI18n();
  const {
    workspaceTabs,
    activeTabId,
    activeServerId,
    dockTabs,
    dockLayout,
    setDockLayout,
    activateTab,
    handleSelectServer,
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
      activeServerId: activeServerId ?? selectedServerId,
    }),
    [activeServerId, selectedServerId],
  );

  const handleSidebarSelect = useCallback(
    (serverId: string, mode?: ServerPanelDockOpenMode) => {
      handleSelectServer(serverId, mode);
      onSidebarSelectServer(serverId, mode);
    },
    [handleSelectServer, onSidebarSelectServer],
  );

  const handleActiveTabChange = useCallback(
    (tabId: string) => {
      activateTab(tabId);
      const tab = workspaceTabs.find((item) => item.id === tabId);
      if (tab) {
        onSelectServer(tab.serverId);
      }
    },
    [activateTab, workspaceTabs, onSelectServer],
  );

  const handleCloseDockTab = useCallback(
    (tabId: string) => {
      const closingIndex = workspaceTabs.findIndex((item) => item.id === tabId);
      const nextTabs = workspaceTabs.filter((item) => item.id !== tabId);
      const wasActive = activeTabId === tabId;
      handleCloseTab(tabId);
      if (wasActive && nextTabs.length > 0) {
        const fallback = nextTabs[Math.min(closingIndex, nextTabs.length - 1)];
        onSelectServer(fallback.serverId);
      }
    },
    [handleCloseTab, workspaceTabs, activeTabId, onSelectServer],
  );

  const renderDockPanel = useCallback(
    (tabId: string) => {
      const tab = workspaceTabs.find((item) => item.id === tabId);
      if (!tab) return null;
      const isActive = tabId === activeTabId;
      return renderServerPanel(tab.serverId, tabId, isActive);
    },
    [workspaceTabs, activeTabId, renderServerPanel],
  );

  return (
    <ServerSidebarLinkageProvider value={sidebarLinkageValue}>
      <DockWorkspace
        className="server-panels-workspace"
        leftPreset="server"
        leftSizePx={leftSizePx}
        leftMinPx={LEFT_MIN_PX}
        onLeftResize={handleLeftResize}
        onLeftLayoutChanged={handleLeftLayoutChanged}
        left={
          <ServerPanelSidebar
            servers={servers}
            onSelectServer={handleSidebarSelect}
            onCreateServer={onCreateServer}
            onEditServer={onEditServer}
            onDeleteServer={onDeleteServer}
          />
        }
        main={
          <ServerWorkspaceDock
            dockTabs={dockTabs}
            activeTabId={activeTabId}
            onActiveTabChange={handleActiveTabChange}
            onCloseTab={handleCloseDockTab}
            dockLayout={dockLayout}
            onDockLayoutChange={setDockLayout}
            renderDockPanel={renderDockPanel}
            onTabDoubleClick={handleDockTabDoubleClick}
            panelContentKey={panelContentKey}
            emptyPrompt={t("server.empty.selectServer")}
          />
        }
      />
    </ServerSidebarLinkageProvider>
  );
}
