import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  lazy,
  Suspense,
  startTransition,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { useLocation } from "react-router-dom";
import { ModuleSegmentDock, openDockTabNow, closeDockTabNow } from "../../components/dock";
import { ModuleWorkspaceLayout } from "../../components/workspace";
import { WorkspaceEmptyPage } from "../../components/ui/workspace/WorkspaceEmptyPage";
import { ContextMenu, buildTabCloseMenuItems, type TabContextMenuAction } from "../../components/ui/menu";
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
import { EMPTY_DOCKER_SIDEBAR_CONTAINERS } from "./dockerSidebarCache";
import { DockerModuleContextBridge } from "./ai/DockerModuleContextBridge";
import {
  connectionSupportsSidebarResources,
  refreshAllDockerSidebarCaches,
  refreshDockerConnectionSidebarCache,
} from "./hooks/useDockerConnectionResources";
import {
  createDockerSidebarCacheRefreshReporter,
  publishDockerSidebarCacheRefreshFailed,
} from "./dockerSidebarCacheStatusLog";
import { DockerConnectionInfoPanel } from "./DockerConnectionInfoPanel";
import { DockerConnectionSidebar } from "./DockerConnectionSidebar";
import { DockerSidebarLinkageProvider } from "./DockerSidebarLinkageContext";
import { isBuiltinLocalDockerConnection } from "./constants";
import type { DockerConnectionDockOpenMode } from "./dockerConnectionWorkspaceTabs";
import {
  isDockerComposeTab,
  isDockerContainerTab,
} from "./dockerConnectionWorkspaceTabs";
import {
  containerRowLabel,
  makeDockerComposeProjectTreeKey,
  makeDockerTreeKey,
} from "./dockerResourceLabels";
import type { DockerSidebarNavTarget } from "./dockerSidebarNav";
import { useDockerConnections } from "./hooks/useDockerConnections";
import type { Connection, DockerConnectionInfo, DockerContainerSummary } from "../../ipc/bindings";

const DockerContainerDockPanel = lazy(() =>
  import("./DockerContainerDockPanel").then((mod) => ({ default: mod.DockerContainerDockPanel })),
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

  const { connections, loading: connectionsLoading, reloadConnections } = useDockerConnections();
  const hydrateSidebarCache = useDockerSidebarCacheStore((s) => s.hydrate);
  const sidebarCacheHydrated = useDockerSidebarCacheStore((s) => s.hydrated);

  useEffect(() => {
    if (!moduleLive || sidebarCacheHydrated) {
      return;
    }
    void hydrateSidebarCache();
  }, [moduleLive, sidebarCacheHydrated, hydrateSidebarCache]);

  const [refreshingAllCaches, setRefreshingAllCaches] = useState(false);
  const [tabCtxMenu, setTabCtxMenu] = useState<{
    x: number;
    y: number;
    tabId: string;
    index: number;
  } | null>(null);

  const dockTabs = useDockerPanelDockStore((s) => s.tabs);
  const activeTabId = useDockerPanelDockStore((s) => s.activeTabId);
  const dockLayout = useDockerPanelDockStore((s) => s.dockLayout);
  const selectConnection = useDockerPanelDockStore((s) => s.selectConnection);
  const selectContainer = useDockerPanelDockStore((s) => s.selectContainer);
  const selectCompose = useDockerPanelDockStore((s) => s.selectCompose);
  const closeTab = useDockerPanelDockStore((s) => s.closeTab);
  const handleCloseTab = useCallback(
    (tabId: string) => {
      closeDockTabNow({
        removeTabSync: () => closeTab(tabId),
      });
    },
    [closeTab],
  );

  const handleDockTabContextMenu = useCallback(
    (event: ReactMouseEvent, tabId: string, index: number) => {
      event.preventDefault();
      setTabCtxMenu({ x: event.clientX, y: event.clientY, tabId, index });
    },
    [],
  );

  useEffect(() => {
    if (!isActiveRoute) {
      setTabCtxMenu(null);
    }
  }, [isActiveRoute]);
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
        out[connectionId] =
          state.connections[connectionId]?.containers ?? EMPTY_DOCKER_SIDEBAR_CONTAINERS;
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
        const containers = sidebarContainersForTabs[tab.connectionId] ?? EMPTY_DOCKER_SIDEBAR_CONTAINERS;
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
      // 先同步开 Tab（transition 保侧栏反馈），数据由 panel isActive 后异步拉取
      openDockTabNow({
        applyTabSync: () => {
          startTransition(() => {
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

            // 镜像 / 网络 / 卷 / 容器列表：打开连接 Dock，由连接内分段 Tab 承接
            selectConnection(target.connectionId, mode);
            if (target.category) {
              setActiveNavKey(makeDockerTreeKey(target.connectionId, target.category));
            } else {
              setActiveNavKey(makeDockerTreeKey(target.connectionId));
            }
          });
        },
      });
    },
    [selectConnection, selectContainer, selectCompose, setActiveNavKey],
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
    if (isDockerComposeTab(tab)) {
      setActiveNavKey(makeDockerComposeProjectTreeKey(tab.connectionId, tab.composeProject));
      return;
    }
    // 连接 Dock：若侧栏导航已指向同连接的分段 Tab（镜像/网络等），不要冲掉
    const connectionKey = makeDockerTreeKey(tab.connectionId);
    setActiveNavKey((prev) => {
      if (prev === connectionKey || prev?.startsWith(`${connectionKey}:`)) {
        return prev;
      }
      return connectionKey;
    });
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

  const handleDeleteDockerConnection = async (connectionId: string | string[]) => {
    const ids = (Array.isArray(connectionId) ? connectionId : [connectionId]).filter(
      (id) => !isBuiltinLocalDockerConnection(id),
    );
    if (ids.length === 0) return;
    const confirmed = await appConfirm(
      ids.length === 1
        ? t("docker.sidebar.deleteConfirm")
        : t("sidebarTree.confirmDeleteSelected", { count: String(ids.length) }),
    );
    if (!confirmed) return;
    for (const id of ids) {
      removeConnectionTabs(id);
      useDockerSidebarCacheStore.getState().removeConnection(id);
      await removeStoredConnection(id);
    }
    void reloadConnections();
    showToast(t("docker.sidebar.deleted"));
  };

  const handleRefreshAllCaches = useCallback(async () => {
    if (refreshingAllCaches) return;
    const ids = connections
      .filter(connectionSupportsSidebarResources)
      .map((connection) => connection.connectionId);
    if (ids.length === 0) return;
    setRefreshingAllCaches(true);
    try {
      await refreshAllDockerSidebarCaches(
        ids,
        createDockerSidebarCacheRefreshReporter(
          t,
          (connectionId) => connectionById.get(connectionId)?.name ?? connectionId,
        ),
      );
    } catch (error) {
      publishDockerSidebarCacheRefreshFailed(
        t,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setRefreshingAllCaches(false);
    }
  }, [connectionById, connections, refreshingAllCaches, t]);

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
            const containers = sidebarContainersForTabs[tab.connectionId] ?? EMPTY_DOCKER_SIDEBAR_CONTAINERS;
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
    [connectionById, dockTabs, sidebarContainersForTabs],
  );

  const handleTabContextAction = useCallback(
    (action: TabContextMenuAction) => {
      if (!tabCtxMenu) return;
      const { tabId } = tabCtxMenu;
      const visibleTabs = moduleDockTabs;
      const idx = visibleTabs.findIndex((tab) => tab.id === tabId);

      if (action === "close") {
        handleCloseTab(tabId);
      } else if (action === "closeLeft") {
        if (idx > 0) {
          for (const tab of visibleTabs.slice(0, idx)) {
            handleCloseTab(tab.id);
          }
        }
      } else if (action === "closeRight") {
        if (idx >= 0 && idx < visibleTabs.length - 1) {
          for (const tab of visibleTabs.slice(idx + 1)) {
            handleCloseTab(tab.id);
          }
        }
      } else if (action === "closeOthers") {
        if (idx >= 0) {
          for (const tab of visibleTabs.filter((item) => item.id !== tabId)) {
            handleCloseTab(tab.id);
          }
        }
      } else if (action === "closeAll") {
        for (const tab of visibleTabs) {
          handleCloseTab(tab.id);
        }
      }
      setTabCtxMenu(null);
    },
    [handleCloseTab, moduleDockTabs, tabCtxMenu],
  );

  // renderPanel 经 DockableWorkspace 的 ref 注入；稳定回调 + 最新 refs，避免 dockTabs 变更触发整树 soft-refresh
  const dockTabsRef = useRef(dockTabs);
  const connectionByIdRef = useRef(connectionById);
  const activeTabIdRef = useRef(activeTabId);
  const moduleLiveRef = useRef(moduleLive);
  const reloadConnectionsRef = useRef(reloadConnections);
  dockTabsRef.current = dockTabs;
  connectionByIdRef.current = connectionById;
  activeTabIdRef.current = activeTabId;
  moduleLiveRef.current = moduleLive;
  reloadConnectionsRef.current = reloadConnections;

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
        ) : isDockerComposeTab(tab) ? (
          <Suspense fallback={<DockerPanelLoadingFallback />}>
            <DockerComposePanel
              connection={connection}
              composeProject={tab.composeProject}
              isActive={isActive}
            />
          </Suspense>
        ) : (
          <DockerConnectionInfoPanel
            connection={connection}
            isActive={isActive}
            onConnectionsNeedReload={() => reloadConnectionsRef.current()}
          />
        )}
      </div>
    );
  }, []);

  // 仅路由 live 变化时全局 soft；切 Tab 由 DockableWorkspace 局部 soft bump
  // 连接 status 变更勿写入 softRefreshKey：会在 React commit 中触发 dockview flushSync
  const dockSoftRefreshKey = moduleLive ? "live" : "idle";

  const sidebarLinkageValue = useMemo(
    () => ({
      activeConnectionId,
      activeNavKey,
      onNavigate: handleNavigate,
      connectionById,
    }),
    [activeConnectionId, activeNavKey, connectionById, handleNavigate],
  );

  const dockerAiContext = useMemo(() => {
    const activeTab = dockTabs.find((t) => t.id === activeTabId) ?? null;
    const conn = connections.find((c) => c.connectionId === activeConnectionId);
    const containerId =
      activeTab && isDockerContainerTab(activeTab) ? activeTab.containerId : null;
    const containerName =
      containerId && activeConnectionId
        ? sidebarContainersForTabs[activeConnectionId]?.find(
            (c) => c.id === containerId || c.name === containerId,
          )?.name ?? null
        : null;
    return {
      connectionId: activeConnectionId,
      connectionName: conn?.name ?? null,
      containerId,
      containerName,
      navKey: activeNavKey,
    };
  }, [
    activeConnectionId,
    activeNavKey,
    activeTabId,
    connections,
    dockTabs,
    sidebarContainersForTabs,
  ]);

  return (
    <>
      <DockerModuleContextBridge active={moduleLive} context={dockerAiContext} />
      <DockerSidebarLinkageProvider value={sidebarLinkageValue}>
        <ModuleWorkspaceLayout
          className="docker-connections-workspace"
          leftColumnTitle={t("routes.docker")}
          leftPreset="server"
          leftSidebar={
            <DockerConnectionSidebar
              connections={connections}
              loading={connectionsLoading}
              refreshingAll={refreshingAllCaches}
              onNavigate={handleNavigate}
              onCreate={() => {
                setEditDockerConnection(undefined);
                setShowAddConn(true);
              }}
              onRefreshAll={() => void handleRefreshAllCaches()}
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
            onCloseTab={handleCloseTab}
            onTabContextMenu={handleDockTabContextMenu}
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

      {isActiveRoute && tabCtxMenu
        ? (() => {
            const menuTabIndex = moduleDockTabs.findIndex((tab) => tab.id === tabCtxMenu.tabId);
            return (
              <ContextMenu
                items={buildTabCloseMenuItems(
                  t,
                  moduleDockTabs.length,
                  menuTabIndex >= 0 ? menuTabIndex : tabCtxMenu.index,
                  handleTabContextAction,
                )}
                position={{ x: tabCtxMenu.x, y: tabCtxMenu.y }}
                onClose={() => setTabCtxMenu(null)}
              />
            );
          })()
        : null}

      {showAddConn ? (
        <Suspense fallback={null}>
          <DockerConnectionDialog
            open={showAddConn}
            onClose={() => {
              setShowAddConn(false);
              setEditDockerConnection(undefined);
            }}
            editConnection={editDockerConnection}
            onSaved={(connection) => {
              void reloadConnections();
              refreshDockerConnectionSidebarCache(connection.id);
              setEditDockerConnection(undefined);
            }}
          />
        </Suspense>
      ) : null}

      {toast ? <div className="docker-toast">{toast}</div> : null}
    </>
  );
}
