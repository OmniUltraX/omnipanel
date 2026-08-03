import { useCallback, useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useLocation } from "react-router-dom";
import { ModuleSegmentDock, openDockTabNow, closeDockTabNow } from "../../components/dock";
import type { DockHeaderIconKind } from "../../components/dock/DockHeaderIcon";
import { ModuleWorkspaceLayout } from "../../components/workspace";
import { ModuleAskAiButton } from "../../components/ai/ModuleAskAiButton";
import { WorkspaceEmptyPage } from "../../components/ui/workspace/WorkspaceEmptyPage";
import { ContextMenu, buildTabCloseMenuItems, type TabContextMenuAction } from "../../components/ui/menu";
import { useModuleSuspended } from "../../lib/moduleVisibility";
import { useConnectionStore } from "../../stores/connectionStore";
import { useServerPanelCacheStore } from "../../stores/serverPanelCacheStore";
import { useI18n } from "../../i18n";
import { appConfirm } from "../../lib/appConfirm";
import { ServerConnectionDialog } from "./panel/ServerConnectionDialog";
import { ServerPanelSidebar } from "./panel/ServerPanelSidebar";
import { CloudConnectionDialog } from "./cloud/CloudConnectionDialog";
import { CloudDockPanel } from "./cloud/CloudDockPanel";
import { connectionToCloudAccount, type CloudAccount } from "./cloud/cloudForm";
import { resolvePanelBrandIcon } from "./brandIcons";
import {
  makeCloudTreeKey,
  type CloudSidebarNavTarget,
} from "./cloud/cloudSidebarNav";
import { CONNECTION_TAG_KINDS } from "../tags/tagKinds";
import { passTagFilter, useModuleTagFilter } from "../tags/useModuleTagFilter";
import { ServerSidebarLinkageProvider } from "./panel/ServerSidebarLinkageContext";
import { ServerDockPanel } from "./panel/ServerDockPanel";
import { ServerWebsitesTab } from "./panel/tabs/ServerWebsitesTab";
import { ServerCertificatesTab } from "./panel/tabs/ServerCertificatesTab";
import { ServerCronjobsTab } from "./panel/tabs/ServerCronjobsTab";
import {
  isCloudOverviewTab,
  isServerOverviewTab,
  isServerResourceTab,
  type ServerPanelDockOpenMode,
} from "./panel/serverPanelWorkspaceTabs";
import { makeServerTreeKey } from "./panel/serverResourceLabels";
import type { ServerSidebarNavTarget } from "./panel/serverSidebarNav";
import type { ServerEntry } from "./panel/serverConnection";
import type { Connection } from "../../ipc/bindings";
import {
  useActiveServerPanelId,
  useServerPanelDockStore,
} from "../../stores/serverPanelDockStore";
import { useUiFollowConsumer } from "../../lib/ai/uiFollow";
import type { ServerPanelResourceKind } from "./panel/serverPanelWorkspaceTabs";

export function ServerPanel() {
  const { t } = useI18n();
  const location = useLocation();
  const isActiveRoute = location.pathname === "/module/server";
  const moduleSuspended = useModuleSuspended();
  const moduleLive = isActiveRoute && !moduleSuspended;
  const connections = useConnectionStore((s) => s.connections);
  const connectionsLoaded = useConnectionStore((s) => s.loaded);
  const removeConn = useConnectionStore((s) => s.remove);
  const panelServers = useServerPanelCacheStore((s) => s.panelServers);
  const tagAllowedIds = useModuleTagFilter("server", CONNECTION_TAG_KINDS);
  const visiblePanelServers = useMemo(
    () => panelServers.filter((s) => passTagFilter(tagAllowedIds, s.id)),
    [panelServers, tagAllowedIds],
  );
  const cloudAccounts = useMemo(() => {
    const list: CloudAccount[] = [];
    for (const conn of connections) {
      const account = connectionToCloudAccount(conn);
      if (account && passTagFilter(tagAllowedIds, account.id)) {
        list.push(account);
      }
    }
    return list;
  }, [connections, tagAllowedIds]);
  const syncPanelServersFromConnections = useServerPanelCacheStore(
    (s) => s.syncPanelServersFromConnections,
  );
  const removeServerCache = useServerPanelCacheStore((s) => s.removeServer);

  // 连接本地库就绪后，同步面板实例列表到模块缓存（不访问远端面板 API）
  useEffect(() => {
    if (!connectionsLoaded) return;
    syncPanelServersFromConnections(connections);
  }, [connections, connectionsLoaded, syncPanelServersFromConnections]);

  const dockTabs = useServerPanelDockStore((s) => s.tabs);
  const activeTabId = useServerPanelDockStore((s) => s.activeTabId);
  const dockLayout = useServerPanelDockStore((s) => s.dockLayout);
  const selectServer = useServerPanelDockStore((s) => s.selectServer);
  const selectCloud = useServerPanelDockStore((s) => s.selectCloud);
  const selectServerResource = useServerPanelDockStore((s) => s.selectServerResource);
  const closeTab = useServerPanelDockStore((s) => s.closeTab);
  const setActiveTabId = useServerPanelDockStore((s) => s.setActiveTabId);
  const setDockLayout = useServerPanelDockStore((s) => s.setDockLayout);
  const removeServerTabs = useServerPanelDockStore((s) => s.removeServerTabs);

  // === AI Follow 消费者注册 ===
  // 处理 selectServer / openConnection intent：定位到指定 server 或其子资源
  useUiFollowConsumer("server", useCallback((intent) => {
    switch (intent.type) {
      case "selectServer": {
        if (intent.kind) {
          selectServerResource(intent.serverId, intent.kind as ServerPanelResourceKind, "permanent");
        } else {
          selectServer(intent.serverId, "permanent");
        }
        return true;
      }
      case "openConnection": {
        const conn = useConnectionStore.getState().connections.find((c) => c.id === intent.resourceId);
        if (conn?.kind === "cloud") {
          selectCloud(intent.resourceId, "permanent");
        } else {
          selectServer(intent.resourceId, "permanent");
        }
        return true;
      }
      default:
        return false;
    }
  }, [selectCloud, selectServer, selectServerResource]));

  const activeServerId = useActiveServerPanelId();

  const [showDialog, setShowDialog] = useState(false);
  const [editPanelConnection, setEditPanelConnection] = useState<Connection | undefined>();
  const [showCloudDialog, setShowCloudDialog] = useState(false);
  const [editCloudConnection, setEditCloudConnection] = useState<Connection | undefined>();
  const [activeNavKey, setActiveNavKey] = useState<string | null>(null);
  const [activeCloudNavKey, setActiveCloudNavKey] = useState<string | null>(null);
  const [navTarget, setNavTarget] = useState<ServerSidebarNavTarget | null>(null);
  const [cloudNavTarget, setCloudNavTarget] = useState<CloudSidebarNavTarget | null>(null);
  const [tabCtxMenu, setTabCtxMenu] = useState<{
    x: number;
    y: number;
    tabId: string;
    index: number;
  } | null>(null);

  const serverById = useMemo(() => {
    const map = new Map<string, ServerEntry>();
    for (const server of panelServers) {
      map.set(server.id, server);
    }
    return map;
  }, [panelServers]);

  const cloudById = useMemo(() => {
    const map = new Map<string, CloudAccount>();
    for (const account of cloudAccounts) {
      map.set(account.id, account);
    }
    return map;
  }, [cloudAccounts]);

  useEffect(() => {
    const validIds = new Set([
      ...panelServers.map((server) => server.id),
      ...cloudAccounts.map((account) => account.id),
    ]);
    const staleServerIds = [
      ...new Set(
        useServerPanelDockStore
          .getState()
          .tabs.filter((tab) => !validIds.has(tab.serverId))
          .map((tab) => tab.serverId),
      ),
    ];
    for (const serverId of staleServerIds) {
      removeServerTabs(serverId);
    }
  }, [cloudAccounts, panelServers, removeServerTabs]);

  useEffect(() => {
    if (!isActiveRoute) {
      setTabCtxMenu(null);
    }
  }, [isActiveRoute]);

  const handleNavigate = useCallback(
    (target: ServerSidebarNavTarget, mode: ServerPanelDockOpenMode = "permanent") => {
      openDockTabNow({
        applyTabSync: () => {
          if (target.detailTab) {
            selectServerResource(target.serverId, target.detailTab, mode);
            setNavTarget(target);
            setActiveNavKey(makeServerTreeKey(target.serverId, target.detailTab));
            return;
          }
          selectServer(target.serverId, mode);
          setNavTarget(target);
          setActiveNavKey(makeServerTreeKey(target.serverId));
        },
      });
    },
    [selectServer, selectServerResource],
  );

  const handleNavigateCloud = useCallback(
    (target: CloudSidebarNavTarget, mode: ServerPanelDockOpenMode = "permanent") => {
      openDockTabNow({
        applyTabSync: () => {
          selectCloud(target.accountId, mode);
          setCloudNavTarget(target);
          setActiveCloudNavKey(makeCloudTreeKey(target.accountId, target.region));
        },
      });
    },
    [selectCloud],
  );

  useEffect(() => {
    const tab = dockTabs.find((item) => item.id === activeTabId);
    if (!tab) {
      setActiveNavKey(null);
      setActiveCloudNavKey(null);
      return;
    }
    if (isCloudOverviewTab(tab)) {
      setActiveNavKey(null);
      setActiveCloudNavKey((prev) => {
        const accountKey = makeCloudTreeKey(tab.serverId);
        if (prev === accountKey || prev?.startsWith(`${accountKey}:`)) {
          return prev;
        }
        return accountKey;
      });
      return;
    }
    setActiveCloudNavKey(null);
    if (isServerResourceTab(tab)) {
      setActiveNavKey(makeServerTreeKey(tab.serverId, tab.kind));
      return;
    }
    setActiveNavKey((prev) => {
      const serverKey = makeServerTreeKey(tab.serverId);
      if (prev === serverKey || prev?.startsWith(`${serverKey}:`)) {
        return prev;
      }
      return serverKey;
    });
  }, [activeTabId, dockTabs]);

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

  const handleCreateServer = useCallback(() => {
    setEditPanelConnection(undefined);
    setShowDialog(true);
  }, []);

  const handleEditServer = useCallback(
    (server: ServerEntry) => {
      const conn = connections.find((c) => c.id === server.id);
      setEditPanelConnection(conn);
      setShowDialog(true);
    },
    [connections],
  );

  const handleDeleteServer = useCallback(
    async (serverId: string | string[]) => {
      const ids = Array.isArray(serverId) ? serverId : [serverId];
      if (ids.length === 0) return;
      const confirmed = await appConfirm(
        ids.length === 1
          ? t("server.sidebar.delete")
          : t("sidebarTree.confirmDeleteSelected", { count: String(ids.length) }),
      );
      if (!confirmed) return;
      for (const id of ids) {
        removeServerTabs(id);
        removeServerCache(id);
        await removeConn(id);
      }
    },
    [removeConn, removeServerCache, removeServerTabs, t],
  );

  const handleCreateCloud = useCallback(() => {
    setEditCloudConnection(undefined);
    setShowCloudDialog(true);
  }, []);

  const handleEditCloud = useCallback(
    (account: CloudAccount) => {
      const conn = connections.find((c) => c.id === account.id);
      setEditCloudConnection(conn);
      setShowCloudDialog(true);
    },
    [connections],
  );

  const handleDeleteCloud = useCallback(
    async (accountId: string | string[]) => {
      const ids = Array.isArray(accountId) ? accountId : [accountId];
      if (ids.length === 0) return;
      const confirmed = await appConfirm(
        ids.length === 1
          ? t("server.cloud.sidebar.delete")
          : t("sidebarTree.confirmDeleteSelected", { count: String(ids.length) }),
      );
      if (!confirmed) return;
      for (const id of ids) {
        removeServerTabs(id);
        await removeConn(id);
      }
    },
    [removeConn, removeServerTabs, t],
  );

  const moduleDockTabs = useMemo(
    () =>
      dockTabs
        .map((tab) => {
          if (isCloudOverviewTab(tab)) {
            const account = cloudById.get(tab.serverId);
            if (!account) return null;
            return {
              id: tab.id,
              label: `${t("server.cloud.sidebar.title")}@${account.name}`,
              panelType: "server-panel",
              icon: (account.provider === "aliyun" ? "aliyun" : "server") as DockHeaderIconKind,
              closable: true,
              preview: tab.preview,
              tooltip: `${account.regions.join(", ")} · ${account.accessKeyId}`,
            };
          }
          const server = serverById.get(tab.serverId);
          if (!server) return null;
          const featureLabel =
            tab.kind === "websites"
              ? t("server.tabs.websites")
              : tab.kind === "certificates"
                ? t("server.tabs.certificates")
                : tab.kind === "cronjobs"
                  ? t("server.tabs.cronjobs")
                  : t("server.tabs.panel");
          const panelBrand = resolvePanelBrandIcon(server.serviceType);
          const icon: DockHeaderIconKind =
            tab.kind === "websites"
              ? "websites"
              : tab.kind === "certificates"
                ? "certificates"
                : tab.kind === "cronjobs"
                  ? "cronjobs"
                  : panelBrand ?? "server";
          return {
            id: tab.id,
            label: `${featureLabel}@${server.name}`,
            panelType: "server-panel",
            icon,
            closable: true,
            preview: tab.preview,
            tooltip: server.address,
          };
        })
        .filter((tab): tab is NonNullable<typeof tab> => tab != null),
    [cloudById, dockTabs, serverById, t],
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

  const renderServerPanel = useCallback(
    (tabId: string) => {
      const tab = dockTabs.find((item) => item.id === tabId);
      if (!tab) {
        return <div className="server-panel-tab-pane" aria-hidden />;
      }
      const isActive = activeTabId === tabId;
      if (isCloudOverviewTab(tab)) {
        const account = cloudById.get(tab.serverId);
        if (!account) {
          return <div className="server-panel-tab-pane" aria-hidden />;
        }
        return (
          <CloudDockPanel
            account={account}
            isActive={isActive && moduleLive}
            navTarget={cloudNavTarget?.accountId === account.id ? cloudNavTarget : null}
          />
        );
      }
      const server = serverById.get(tab.serverId);
      if (!server) {
        return <div className="server-panel-tab-pane" aria-hidden />;
      }
      if (isServerOverviewTab(tab)) {
        return (
          <div className="server-main">
            <ServerDockPanel
              server={server}
              isActive={isActive}
              moduleLive={moduleLive}
              navTarget={navTarget?.serverId === server.id ? navTarget : null}
            />
          </div>
        );
      }
      if (!moduleLive || !isActive) {
        return <div className="server-panel-tab-pane" aria-hidden />;
      }
      return (
        <div className="server-main server-main--resource">
          <div className="server-content">
            {tab.kind === "websites" ? <ServerWebsitesTab server={server} /> : null}
            {tab.kind === "certificates" ? <ServerCertificatesTab server={server} /> : null}
            {tab.kind === "cronjobs" ? <ServerCronjobsTab server={server} /> : null}
          </div>
        </div>
      );
    },
    [activeTabId, cloudById, cloudNavTarget, dockTabs, moduleLive, navTarget, serverById],
  );

  const sidebarLinkageValue = useMemo(
    () => ({
      activeServerId,
      activeNavKey,
      onNavigate: handleNavigate,
    }),
    [activeNavKey, activeServerId, handleNavigate],
  );

  const activeCloudAccountId = useMemo(() => {
    const tab = dockTabs.find((item) => item.id === activeTabId);
    return tab && isCloudOverviewTab(tab) ? tab.serverId : null;
  }, [activeTabId, dockTabs]);

  return (
    <>
      <ServerSidebarLinkageProvider value={sidebarLinkageValue}>
        <ModuleWorkspaceLayout
          className="server-panels-workspace"
          leftColumnTitle={t("routes.server")}
          leftPreset="server"
          tagModuleKey="server"
          leftHeaderActions={<ModuleAskAiButton moduleKey="server" />}
          leftSidebar={
            <ServerPanelSidebar
              servers={visiblePanelServers}
              cloudAccounts={cloudAccounts}
              onCreateServer={handleCreateServer}
              onEditServer={handleEditServer}
              onDeleteServer={handleDeleteServer}
              onCreateCloud={handleCreateCloud}
              onEditCloud={handleEditCloud}
              onDeleteCloud={handleDeleteCloud}
              onNavigateCloud={handleNavigateCloud}
              activeCloudAccountId={activeCloudAccountId}
              activeCloudNavKey={activeCloudNavKey}
            />
          }
        >
          <ModuleSegmentDock
            className="server-module-dock"
            variant="workspace"
            dockScope="server-panel"
            tabs={moduleDockTabs}
            activeTabId={activeTabId ?? ""}
            onActiveTabChange={setActiveTabId}
            onCloseTab={handleCloseTab}
            onTabContextMenu={handleDockTabContextMenu}
            enabled={isActiveRoute}
            stickyVisit
            contentSuspended={!moduleLive}
            savedLayout={dockLayout}
            onSavedLayoutChange={setDockLayout}
            renderPanel={renderServerPanel}
            emptyContent={
              <WorkspaceEmptyPage
                title={t("routes.server")}
                prompt={t("server.empty.selectServer")}
              />
            }
          />
        </ModuleWorkspaceLayout>
      </ServerSidebarLinkageProvider>

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

      <ServerConnectionDialog
        open={showDialog}
        onClose={() => setShowDialog(false)}
        onSaved={() => setShowDialog(false)}
        editPanelConnection={editPanelConnection}
      />
      <CloudConnectionDialog
        open={showCloudDialog}
        onClose={() => setShowCloudDialog(false)}
        onSaved={() => setShowCloudDialog(false)}
        editConnection={editCloudConnection}
      />
    </>
  );
}
