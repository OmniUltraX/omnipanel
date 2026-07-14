import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from "react";
import { useShallow } from "zustand/react/shallow";
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
import { useDockerSidebarCacheStore } from "../../stores/dockerSidebarCacheStore";
import { DockerConnectionInfoPanel } from "./DockerConnectionInfoPanel";
import { DockerConnectionSidebar } from "./DockerConnectionSidebar";
import { DockerSidebarLinkageProvider } from "./DockerSidebarLinkageContext";
import { isBuiltinLocalDockerConnection } from "./constants";
import type { DockerConnectionDockOpenMode } from "./dockerConnectionWorkspaceTabs";
import {
  isDockerComposeTab,
  isDockerContainerTab,
  isDockerContainersTab,
  isDockerImagesTab,
  isDockerNetworksTab,
  isDockerVolumesTab,
} from "./dockerConnectionWorkspaceTabs";
import { containerRowLabel, makeDockerComposeProjectTreeKey, makeDockerTreeKey } from "./dockerResourceLabels";
import type { DockerSidebarNavTarget } from "./dockerSidebarNav";
import { useDockerConnections } from "./hooks/useDockerConnections";
import type { Connection, DockerConnectionInfo, DockerContainerSummary } from "../../ipc/bindings";

const DockerContainerDockPanel = lazy(() =>
  import("./DockerContainerDockPanel").then((mod) => ({ default: mod.DockerContainerDockPanel })),
);

const DockerContainerPanel = lazy(() =>
  import("./DockerContainerPanel").then((mod) => ({ default: mod.DockerContainerPanel })),
);

const DockerImagePanel = lazy(() =>
  import("./DockerImagePanel").then((mod) => ({ default: mod.DockerImagePanel })),
);

const DockerNetworkPanel = lazy(() =>
  import("./DockerNetworkPanel").then((mod) => ({ default: mod.DockerNetworkPanel })),
);

const DockerVolumePanel = lazy(() =>
  import("./DockerVolumePanel").then((mod) => ({ default: mod.DockerVolumePanel })),
);

const DockerComposePanel = lazy(() =>
  import("./DockerComposePanel").then((mod) => ({ default: mod.DockerComposePanel })),
);

const DockerConnectionDialog = lazy(() =>
  import("./DockerConnectionDialog").then((mod) => ({ default: mod.DockerConnectionDialog })),
);

function DockerPanelLoadingFallback() {
  return <div className="docker-panel-loading-fallback" aria-hidden />;
}

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
  const selectContainer = useDockerPanelDockStore((s) => s.selectContainer);
  const selectContainers = useDockerPanelDockStore((s) => s.selectContainers);
  const selectImages = useDockerPanelDockStore((s) => s.selectImages);
  const selectNetworks = useDockerPanelDockStore((s) => s.selectNetworks);
  const selectVolumes = useDockerPanelDockStore((s) => s.selectVolumes);
  const selectCompose = useDockerPanelDockStore((s) => s.selectCompose);
  const closeTab = useDockerPanelDockStore((s) => s.closeTab);
  const setActiveTabId = useDockerPanelDockStore((s) => s.setActiveTabId);
  const setDockLayout = useDockerPanelDockStore((s) => s.setDockLayout);
  const removeConnectionTabs = useDockerPanelDockStore((s) => s.removeConnectionTabs);
  const removeContainerTabs = useDockerPanelDockStore((s) => s.removeContainerTabs);

  const containerTabConnectionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const tab of dockTabs) {
      if (isDockerContainerTab(tab)) {
        ids.add(tab.connectionId);
      }
    }
    return [...ids];
  }, [dockTabs]);

  const sidebarContainersForTabs = useDockerSidebarCacheStore(
    useShallow((state) => {
      const out: Record<string, DockerContainerSummary[]> = {};
      for (const connectionId of containerTabConnectionIds) {
        out[connectionId] = state.connections[connectionId]?.containers ?? [];
      }
      return out;
    }),
  );

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

  const validIds = useMemo(
    () => new Set(connections.map((connection) => connection.connectionId)),
    [connections],
  );

  // 连接列表未就绪前不能做过期清理：validIds 为空时会误删刚从 localStorage 恢复的 Dock Tab
  useEffect(() => {
    if (connectionsLoading) return;

    const pruneStaleTabs = () => {
      const tabs = useDockerPanelDockStore.getState().tabs;
      const staleConnectionIds = [
        ...new Set(
          tabs.filter((tab) => !validIds.has(tab.connectionId)).map((tab) => tab.connectionId),
        ),
      ];
      for (const connectionId of staleConnectionIds) {
        removeConnectionTabs(connectionId);
      }

      for (const tab of tabs) {
        if (!isDockerContainerTab(tab) || !validIds.has(tab.connectionId)) continue;
        const containers = sidebarContainersForTabs[tab.connectionId] ?? [];
        const normalized = tab.containerId.trim().toLowerCase();
        const exists = containers.some(
          (container) =>
            container.id.trim().toLowerCase() === normalized ||
            container.shortId.trim().toLowerCase() === normalized,
        );
        if (!exists && containers.length > 0) {
          removeContainerTabs(tab.connectionId, tab.containerId);
        }
      }
    };

    if (useDockerPanelDockStore.persist.hasHydrated()) {
      pruneStaleTabs();
      return;
    }
    return useDockerPanelDockStore.persist.onFinishHydration(pruneStaleTabs);
  }, [
    connectionsLoading,
    removeConnectionTabs,
    removeContainerTabs,
    sidebarContainersForTabs,
    validIds,
  ]);

  const showToast = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 3200);
  };

  const handleNavigate = useCallback(
    (target: DockerSidebarNavTarget, mode: DockerConnectionDockOpenMode = "permanent") => {
      if (target.composeProject) {
        selectCompose(target.connectionId, target.composeProject, mode);
        setActiveNavKey(
          makeDockerComposeProjectTreeKey(target.connectionId, target.composeProject),
        );
      return;
    }

      if (target.category === "containers" && target.itemId) {
        selectContainer(target.connectionId, target.itemId, mode);
        setActiveNavKey(makeDockerTreeKey(target.connectionId, target.category, target.itemId));
        return;
      }

      if (target.category === "containers" && !target.itemId) {
        selectContainers(target.connectionId, mode);
        setActiveNavKey(makeDockerTreeKey(target.connectionId, "containers"));
        return;
      }

      if (target.category === "images" && !target.itemId) {
        selectImages(target.connectionId, mode);
        setActiveNavKey(makeDockerTreeKey(target.connectionId, "images"));
        return;
      }

      if (target.category === "networks" && !target.itemId) {
        selectNetworks(target.connectionId, mode);
        setActiveNavKey(makeDockerTreeKey(target.connectionId, "networks"));
        return;
      }

      if (target.category === "volumes" && !target.itemId) {
        selectVolumes(target.connectionId, mode);
        setActiveNavKey(makeDockerTreeKey(target.connectionId, "volumes"));
        return;
      }

      selectConnection(target.connectionId, mode);
      if (target.itemId && target.category) {
        setActiveNavKey(makeDockerTreeKey(target.connectionId, target.category, target.itemId));
      } else if (target.category) {
        setActiveNavKey(makeDockerTreeKey(target.connectionId, target.category));
        } else {
        setActiveNavKey(makeDockerTreeKey(target.connectionId));
      }
    },
    [
      selectConnection,
      selectContainer,
      selectContainers,
      selectCompose,
      selectImages,
      selectNetworks,
      selectVolumes,
    ],
  );

  useEffect(() => {
    const tab = dockTabs.find((item) => item.id === activeTabId);
    if (!tab) {
      setActiveNavKey(null);
      return;
    }
    if (isDockerContainerTab(tab)) {
      setActiveNavKey(makeDockerTreeKey(tab.connectionId, "containers", tab.containerId));
      return;
    }
    if (isDockerContainersTab(tab)) {
      setActiveNavKey(makeDockerTreeKey(tab.connectionId, "containers"));
      return;
    }
    if (isDockerImagesTab(tab)) {
      setActiveNavKey(makeDockerTreeKey(tab.connectionId, "images"));
      return;
    }
    if (isDockerNetworksTab(tab)) {
      setActiveNavKey(makeDockerTreeKey(tab.connectionId, "networks"));
      return;
    }
    if (isDockerVolumesTab(tab)) {
      setActiveNavKey(makeDockerTreeKey(tab.connectionId, "volumes"));
      return;
    }
    if (isDockerComposeTab(tab)) {
      setActiveNavKey(makeDockerComposeProjectTreeKey(tab.connectionId, tab.composeProject));
      return;
    }
    setActiveNavKey(makeDockerTreeKey(tab.connectionId));
  }, [activeTabId, dockTabs]);

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

          if (isDockerContainerTab(tab)) {
            const containers = sidebarContainersForTabs[tab.connectionId] ?? [];
            const normalized = tab.containerId.trim().toLowerCase();
            const container = containers.find(
              (item) =>
                item.id.trim().toLowerCase() === normalized ||
                item.shortId.trim().toLowerCase() === normalized,
            );
            const containerName = container
              ? containerRowLabel(container)
              : tab.containerId.slice(0, 12);
            return {
              id: tab.id,
              label: containerName,
              panelType: "docker-container",
              icon: "docker-container" as const,
              closable: true,
              preview: tab.preview,
              tooltip: `${connection.name} · ${containerName}`,
            };
          }

          if (isDockerContainersTab(tab)) {
            const containersLabel = t("docker.tabs.containers");
            return {
              id: tab.id,
              label: containersLabel,
              panelType: "docker-containers",
              icon: "docker-containers" as const,
              closable: true,
              preview: tab.preview,
              tooltip: `${connection.name} · ${containersLabel}`,
            };
          }

          if (isDockerImagesTab(tab)) {
            const imagesLabel = t("docker.tabs.images");
            return {
              id: tab.id,
              label: imagesLabel,
              panelType: "docker-images",
              icon: "docker-images" as const,
              closable: true,
              preview: tab.preview,
              tooltip: `${connection.name} · ${imagesLabel}`,
            };
          }

          if (isDockerNetworksTab(tab)) {
            const networksLabel = t("docker.tabs.networks");
            return {
              id: tab.id,
              label: networksLabel,
              panelType: "docker-networks",
              icon: "docker-networks" as const,
              closable: true,
              preview: tab.preview,
              tooltip: `${connection.name} · ${networksLabel}`,
            };
          }

          if (isDockerVolumesTab(tab)) {
            const volumesLabel = t("docker.tabs.volumes");
            return {
              id: tab.id,
              label: volumesLabel,
              panelType: "docker-volumes",
              icon: "docker-volumes" as const,
              closable: true,
              preview: tab.preview,
              tooltip: `${connection.name} · ${volumesLabel}`,
            };
          }

          if (isDockerComposeTab(tab)) {
            return {
              id: tab.id,
              label: tab.composeProject,
              panelType: "docker-compose",
              icon: "docker-compose" as const,
              closable: true,
              preview: tab.preview,
              tooltip: `${connection.name} · ${tab.composeProject}`,
            };
          }

          return {
            id: tab.id,
            label: connection.name,
            panelType: "docker-connection",
            icon: "docker-connection" as const,
            closable: true,
            preview: tab.preview,
            tooltip: connection.hostLabel ?? connection.name,
          };
        })
        .filter((tab): tab is NonNullable<typeof tab> => tab != null),
    [connectionById, dockTabs, sidebarContainersForTabs, t],
  );

  // renderPanel 经 DockableWorkspace 的 ref 注入；稳定回调 + 最新 refs，避免 dockTabs 变更触发整树 soft-refresh
  const dockTabsRef = useRef(dockTabs);
  const connectionByIdRef = useRef(connectionById);
  const activeTabIdRef = useRef(activeTabId);
  const moduleLiveRef = useRef(moduleLive);
  dockTabsRef.current = dockTabs;
  connectionByIdRef.current = connectionById;
  activeTabIdRef.current = activeTabId;
  moduleLiveRef.current = moduleLive;

  const renderDockerPanel = useCallback((tabId: string) => {
    const tab = dockTabsRef.current.find((item) => item.id === tabId);
    if (!tab) {
      return <div className="docker-connection-tab-pane" aria-hidden />;
    }
    const connection = connectionByIdRef.current.get(tab.connectionId);
    if (!connection) {
      return <div className="docker-connection-tab-pane" aria-hidden />;
    }
    const isActive = Boolean(moduleLiveRef.current && activeTabIdRef.current === tabId);

    return (
      <div className="docker-main">
        {isDockerContainerTab(tab) ? (
          <Suspense fallback={<DockerPanelLoadingFallback />}>
            <DockerContainerDockPanel
              connection={connection}
              containerId={tab.containerId}
              isActive={isActive}
            />
          </Suspense>
        ) : isDockerContainersTab(tab) ? (
          <Suspense fallback={<DockerPanelLoadingFallback />}>
            <DockerContainerPanel connection={connection} isActive={isActive} />
          </Suspense>
        ) : isDockerImagesTab(tab) ? (
          <Suspense fallback={<DockerPanelLoadingFallback />}>
            <DockerImagePanel connection={connection} isActive={isActive} />
          </Suspense>
        ) : isDockerNetworksTab(tab) ? (
          <Suspense fallback={<DockerPanelLoadingFallback />}>
            <DockerNetworkPanel connection={connection} isActive={isActive} />
          </Suspense>
        ) : isDockerVolumesTab(tab) ? (
          <Suspense fallback={<DockerPanelLoadingFallback />}>
            <DockerVolumePanel connection={connection} isActive={isActive} />
          </Suspense>
        ) : isDockerComposeTab(tab) ? (
          <Suspense fallback={<DockerPanelLoadingFallback />}>
            <DockerComposePanel
              connection={connection}
              composeProject={tab.composeProject}
              isActive={isActive}
            />
          </Suspense>
        ) : (
          <DockerConnectionInfoPanel connection={connection} isActive={isActive} />
        )}
      </div>
    );
  }, []);

  const dockSoftRefreshKey = `${moduleLive ? 1 : 0}:${activeTabId ?? ""}`;

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
            softRefreshKey={dockSoftRefreshKey}
            emptyContent={
                <WorkspaceEmptyPage
                  title={t("routes.docker")}
                  prompt={t("docker.sidebar.selectConnection")}
                />
            }
          />
        </ModuleWorkspaceLayout>
      </DockerSidebarLinkageProvider>

      {showAddConn ? (
        <Suspense fallback={null}>
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
        </Suspense>
          ) : null}

      {toast ? <div className="docker-toast">{toast}</div> : null}
    </>
  );
}
