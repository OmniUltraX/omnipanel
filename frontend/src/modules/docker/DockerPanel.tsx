import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { ModuleSegmentDock } from "../../components/dock";
import { ModuleWorkspaceLayout } from "../../components/workspace";
import { WorkspaceEmptyPage } from "../../components/ui/workspace/WorkspaceEmptyPage";
import { useModuleSuspended } from "../../lib/moduleVisibility";
import { useConnectionStore } from "../../stores/connectionStore";
import { useI18n } from "../../i18n";
import { appConfirm } from "../../lib/appConfirm";
import { usePoolConnectionRegistration } from "../../stores/connectionPoolStore";
import {
  useActiveDockerPanelConnectionId,
  useDockerPanelDockStore,
} from "../../stores/dockerPanelDockStore";
import { DockerConnectionDialog } from "./DockerConnectionDialog";
import { DockerConnectionSidebar } from "./DockerConnectionSidebar";
import { DockerDockPanel } from "./DockerDockPanel";
import { DockerSidebarLinkageProvider } from "./DockerSidebarLinkageContext";
import { isBuiltinLocalDockerConnection } from "./constants";
import type { DockerConnectionDockOpenMode } from "./dockerConnectionWorkspaceTabs";
import { makeDockerTreeKey } from "./dockerResourceLabels";
import type { DockerSidebarNavTarget } from "./dockerSidebarNav";
import { useDockerConnections } from "./hooks/useDockerConnections";
import type { Connection, DockerConnectionInfo } from "../../ipc/bindings";

export function DockerPanel() {
  const { t } = useI18n();
  const location = useLocation();
  const isActiveRoute = location.pathname === "/module/docker";
  const moduleSuspended = useModuleSuspended();
  const moduleLive = isActiveRoute && !moduleSuspended;

  const storedConnections = useConnectionStore((s) => s.connections);
  const removeStoredConnection = useConnectionStore((s) => s.remove);

  const { connections, loading: connectionsLoading, scanning, reloadConnections, scanSshDockerHosts } =
    useDockerConnections();

  const dockTabs = useDockerPanelDockStore((s) => s.tabs);
  const activeTabId = useDockerPanelDockStore((s) => s.activeTabId);
  const dockLayout = useDockerPanelDockStore((s) => s.dockLayout);
  const selectConnection = useDockerPanelDockStore((s) => s.selectConnection);
  const closeTab = useDockerPanelDockStore((s) => s.closeTab);
  const setActiveTabId = useDockerPanelDockStore((s) => s.setActiveTabId);
  const setDockLayout = useDockerPanelDockStore((s) => s.setDockLayout);
  const removeConnectionTabs = useDockerPanelDockStore((s) => s.removeConnectionTabs);

  const activeConnectionId = useActiveDockerPanelConnectionId();
  usePoolConnectionRegistration("docker", isActiveRoute ? activeConnectionId : null);

  const [activeNavKey, setActiveNavKey] = useState<string | null>(null);
  const [showAddConn, setShowAddConn] = useState(false);
  const [editDockerConnection, setEditDockerConnection] = useState<Connection | undefined>();
  const [toast, setToast] = useState<string | null>(null);

  const connectionById = useMemo(() => {
    const map = new Map<string, DockerConnectionInfo>();
    for (const connection of connections) {
      map.set(connection.connectionId, connection);
    }
    return map;
  }, [connections]);

  useEffect(() => {
    const validIds = new Set(connections.map((connection) => connection.connectionId));
    const staleConnectionIds = [
      ...new Set(
        useDockerPanelDockStore
          .getState()
          .tabs.filter((tab) => !validIds.has(tab.connectionId))
          .map((tab) => tab.connectionId),
      ),
    ];
    for (const connectionId of staleConnectionIds) {
      removeConnectionTabs(connectionId);
    }
  }, [connections, removeConnectionTabs]);

  const showToast = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 3200);
  };

  const handleNavigate = useCallback(
    (target: DockerSidebarNavTarget, mode: DockerConnectionDockOpenMode = "preview") => {
      selectConnection(target.connectionId, mode);
      if (target.itemId && target.category) {
        setActiveNavKey(makeDockerTreeKey(target.connectionId, target.category, target.itemId));
      } else if (target.category) {
        setActiveNavKey(makeDockerTreeKey(target.connectionId, target.category));
      } else {
        setActiveNavKey(makeDockerTreeKey(target.connectionId));
      }
    },
    [selectConnection],
  );

  useEffect(() => {
    if (!activeConnectionId) {
      setActiveNavKey(null);
      return;
    }
    setActiveNavKey((prev) => {
      const rootKey = makeDockerTreeKey(activeConnectionId);
      if (!prev || !prev.startsWith(`${rootKey}`)) {
        return rootKey;
      }
      return prev;
    });
  }, [activeConnectionId]);

  const handleEditDockerConnection = (info: { connectionId: string }) => {
    const conn = storedConnections.find((c) => c.id === info.connectionId);
    if (!conn) {
      showToast(t("docker.sidebar.editFailed"));
      return;
    }
    setEditDockerConnection(conn);
    setShowAddConn(true);
  };

  const handleDeleteDockerConnection = async (connectionId: string) => {
    if (isBuiltinLocalDockerConnection(connectionId)) return;
    if (!(await appConfirm(t("docker.sidebar.deleteConfirm")))) return;
    removeConnectionTabs(connectionId);
    await removeStoredConnection(connectionId);
    void reloadConnections();
    showToast(t("docker.sidebar.deleted"));
  };

  const handleScanSshDocker = async () => {
    const result = await scanSshDockerHosts(true);
    if (!result) {
      showToast("扫描失败");
      return;
    }
    showToast(
      `扫描完成：新增 ${result.created}，更新 ${result.updated}，无 Docker ${result.noDocker}，失败 ${result.failed}`,
    );
  };

  const dockerDeepLinkHandledRef = useRef(false);
  useEffect(() => {
    if (dockerDeepLinkHandledRef.current || connectionsLoading) return;
    const state = location.state as { selectDockerConnectionId?: string } | null;
    const targetId = state?.selectDockerConnectionId;
    if (!targetId || !connections.some((c) => c.connectionId === targetId)) return;
    dockerDeepLinkHandledRef.current = true;
    handleNavigate({ connectionId: targetId }, "permanent");
    window.history.replaceState({}, "");
  }, [connections, connectionsLoading, handleNavigate, location.state]);

  const moduleDockTabs = useMemo(
    () =>
      dockTabs
        .map((tab) => {
          const connection = connectionById.get(tab.connectionId);
          if (!connection) return null;
          return {
            id: tab.id,
            label: connection.name,
            panelType: "docker-connection",
            closable: true,
            preview: tab.preview,
            tooltip: connection.hostLabel ?? connection.name,
          };
        })
        .filter((tab): tab is NonNullable<typeof tab> => tab != null),
    [connectionById, dockTabs],
  );

  const renderDockerPanel = useCallback(
    (tabId: string) => {
      const tab = dockTabs.find((item) => item.id === tabId);
      if (!tab) {
        return <div className="docker-connection-tab-pane" aria-hidden />;
      }
      const connection = connectionById.get(tab.connectionId);
      if (!connection) {
        return <div className="docker-connection-tab-pane" aria-hidden />;
      }
      return (
        <div className="docker-main">
          <DockerDockPanel connection={connection} isActive={moduleLive && activeTabId === tabId} />
        </div>
      );
    },
    [activeTabId, connectionById, dockTabs, moduleLive],
  );

  const sidebarLinkageValue = useMemo(
    () => ({
      activeConnectionId,
      activeNavKey,
      onNavigate: handleNavigate,
    }),
    [activeConnectionId, activeNavKey, handleNavigate],
  );

  return (
    <>
      <DockerSidebarLinkageProvider value={sidebarLinkageValue}>
        <ModuleWorkspaceLayout
          className="docker-connections-workspace"
          leftColumnTitle={t("routes.docker")}
          leftPreset="server"
          leftSidebar={
            <DockerConnectionSidebar
              connections={connections}
              loading={connectionsLoading}
              scanning={scanning}
              onNavigate={handleNavigate}
              onCreate={() => {
                setEditDockerConnection(undefined);
                setShowAddConn(true);
              }}
              onScan={() => void handleScanSshDocker()}
              onEditConnection={handleEditDockerConnection}
              onDeleteConnection={(id) => void handleDeleteDockerConnection(id)}
            />
          }
        >
          <ModuleSegmentDock
            className="docker-module-dock"
            variant="workspace"
            dockScope="docker-panel"
            tabs={moduleDockTabs}
            activeTabId={activeTabId ?? ""}
            onActiveTabChange={setActiveTabId}
            onCloseTab={closeTab}
            enabled={isActiveRoute}
            savedLayout={dockLayout}
            onSavedLayoutChange={setDockLayout}
            renderPanel={renderDockerPanel}
            emptyContent={
              <WorkspaceEmptyPage
                title={t("routes.docker")}
                prompt={t("docker.sidebar.selectConnection")}
              />
            }
          />
        </ModuleWorkspaceLayout>
      </DockerSidebarLinkageProvider>

      <DockerConnectionDialog
        open={showAddConn}
        onClose={() => {
          setShowAddConn(false);
          setEditDockerConnection(undefined);
        }}
        editConnection={editDockerConnection}
        onSaved={() => {
          void reloadConnections();
          setEditDockerConnection(undefined);
        }}
      />

      {toast ? <div className="docker-toast">{toast}</div> : null}
    </>
  );
}
