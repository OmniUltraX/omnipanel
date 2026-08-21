import { useCallback, useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { ModuleSegmentDock, openDockTabNow, closeDockTabNow } from "../../components/dock";
import type { DockHeaderIconKind } from "../../components/dock/DockHeaderIcon";
import { ModuleWorkspaceLayout } from "../../components/workspace";
import { ModuleLeftHeaderActions } from "../../components/ai/ModuleLeftHeaderActions";
import { WorkspaceEmptyPage } from "../../components/ui/workspace/WorkspaceEmptyPage";
import { Button } from "../../components/ui/primitives/Button";
import { ContextMenu, buildTabCloseMenuItems, type TabContextMenuAction } from "../../components/ui/menu";
import { useModuleRouteActive } from "../../lib/useModuleRouteActive";
import { useConnectionStore } from "../../stores/connectionStore";
import { useI18n } from "../../i18n";
import { appConfirm } from "../../lib/appConfirm";
import { CloudConnectionDialog } from "../server/cloud/CloudConnectionDialog";
import { CloudDockPanel } from "../server/cloud/CloudDockPanel";
import { CloudTreeSidebar } from "../server/cloud/CloudTreeSidebar";
import { connectionToCloudAccount, type CloudAccount } from "../server/cloud/cloudForm";
import {
  makeCloudTreeKey,
  type CloudSidebarNavTarget,
} from "../server/cloud/cloudSidebarNav";
import { CONNECTION_TAG_KINDS } from "../tags/tagKinds";
import { passTagFilter, useModuleTagFilter } from "../tags/useModuleTagFilter";
import {
  isCloudOverviewTab,
  type ServerPanelDockOpenMode,
} from "../server/panel/serverPanelWorkspaceTabs";
import type { Connection } from "../../ipc/bindings";
import {
  useServerPanelDockStore,
} from "../../stores/serverPanelDockStore";
import { useUiFollowConsumer } from "../../lib/ai/uiFollow";
import { VerticalSplitSidebar } from "../../components/ui/sidebar/VerticalSplitSidebar";
import { ScopedSearch } from "../../components/ui/search";

export function CloudPanel() {
  const { t } = useI18n();
  const { isActiveRoute, moduleLive } = useModuleRouteActive("cloud");
  const connections = useConnectionStore((s) => s.connections);
  const removeConn = useConnectionStore((s) => s.remove);
  const tagAllowedIds = useModuleTagFilter("cloud", CONNECTION_TAG_KINDS);
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

  const dockTabs = useServerPanelDockStore((s) => s.tabs);
  const activeTabId = useServerPanelDockStore((s) => s.activeTabId);
  const dockLayout = useServerPanelDockStore((s) => s.dockLayout);
  const selectCloud = useServerPanelDockStore((s) => s.selectCloud);
  const closeTab = useServerPanelDockStore((s) => s.closeTab);
  const setActiveTabId = useServerPanelDockStore((s) => s.setActiveTabId);
  const setDockLayout = useServerPanelDockStore((s) => s.setDockLayout);
  const removeServerTabs = useServerPanelDockStore((s) => s.removeServerTabs);

  useUiFollowConsumer("cloud", useCallback((intent) => {
    if (intent.type === "openConnection") {
      const conn = useConnectionStore.getState().connections.find((c) => c.id === intent.resourceId);
      if (conn?.kind === "cloud") {
        selectCloud(intent.resourceId, "permanent");
        return true;
      }
    }
    return false;
  }, [selectCloud]));

  const [showCloudDialog, setShowCloudDialog] = useState(false);
  const [editCloudConnection, setEditCloudConnection] = useState<Connection | undefined>();
  const [activeCloudNavKey, setActiveCloudNavKey] = useState<string | null>(null);
  const [cloudNavTarget, setCloudNavTarget] = useState<CloudSidebarNavTarget | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [tabCtxMenu, setTabCtxMenu] = useState<{
    x: number;
    y: number;
    tabId: string;
    index: number;
  } | null>(null);

  const cloudById = useMemo(() => {
    const map = new Map<string, CloudAccount>();
    for (const account of cloudAccounts) {
      map.set(account.id, account);
    }
    return map;
  }, [cloudAccounts]);

  const cloudTabs = useMemo(
    () => dockTabs.filter((tab) => isCloudOverviewTab(tab)),
    [dockTabs],
  );

  useEffect(() => {
    const validIds = new Set(cloudAccounts.map((account) => account.id));
    for (const tab of cloudTabs) {
      if (!validIds.has(tab.serverId)) {
        removeServerTabs(tab.serverId);
      }
    }
  }, [cloudAccounts, cloudTabs, removeServerTabs]);

  const handleNavigateCloud = useCallback(
    (target: CloudSidebarNavTarget, mode: ServerPanelDockOpenMode = "preview") => {
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
    const tab = cloudTabs.find((item) => item.id === activeTabId);
    if (!tab) {
      setActiveCloudNavKey(null);
      return;
    }
    setActiveCloudNavKey((prev) => {
      const accountKey = makeCloudTreeKey(tab.serverId);
      if (prev === accountKey || prev?.startsWith(`${accountKey}:`)) {
        return prev;
      }
      return accountKey;
    });
  }, [activeTabId, cloudTabs]);

  const handleCloseTab = useCallback(
    (tabId: string) => {
      closeDockTabNow({
        removeTabSync: () => closeTab(tabId),
      });
    },
    [closeTab],
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
      cloudTabs
        .map((tab) => {
          const account = cloudById.get(tab.serverId);
          if (!account) return null;
          return {
            id: tab.id,
            label: `${t("server.cloud.sidebar.title")}@${account.name}`,
            panelType: "cloud-panel",
            icon: (account.provider === "aliyun" ? "aliyun" : "server") as DockHeaderIconKind,
            closable: true,
            preview: tab.preview,
            tooltip: `${account.regions.join(", ")} · ${account.accessKeyId}`,
          };
        })
        .filter((tab): tab is NonNullable<typeof tab> => tab != null),
    [cloudById, cloudTabs, t],
  );

  const handleTabContextAction = useCallback(
    (action: TabContextMenuAction) => {
      if (!tabCtxMenu) return;
      const { tabId } = tabCtxMenu;
      const visibleTabs = moduleDockTabs;
      const idx = visibleTabs.findIndex((tab) => tab.id === tabId);
      if (action === "close") handleCloseTab(tabId);
      else if (action === "closeLeft" && idx > 0) {
        for (const tab of visibleTabs.slice(0, idx)) handleCloseTab(tab.id);
      } else if (action === "closeRight" && idx >= 0 && idx < visibleTabs.length - 1) {
        for (const tab of visibleTabs.slice(idx + 1)) handleCloseTab(tab.id);
      } else if (action === "closeOthers" && idx >= 0) {
        for (const tab of visibleTabs.filter((row) => row.id !== tabId)) handleCloseTab(tab.id);
      } else if (action === "closeAll") {
        for (const tab of visibleTabs) handleCloseTab(tab.id);
      }
      setTabCtxMenu(null);
    },
    [handleCloseTab, moduleDockTabs, tabCtxMenu],
  );

  const renderCloudPanel = useCallback(
    (tabId: string) => {
      const tab = cloudTabs.find((item) => item.id === tabId);
      if (!tab) return <div className="server-panel-tab-pane" aria-hidden />;
      const account = cloudById.get(tab.serverId);
      if (!account) return <div className="server-panel-tab-pane" aria-hidden />;
      const isActive = activeTabId === tabId;
      return (
        <CloudDockPanel
          account={account}
          isActive={isActive && moduleLive}
          navTarget={cloudNavTarget?.accountId === account.id ? cloudNavTarget : null}
        />
      );
    },
    [activeTabId, cloudById, cloudNavTarget, cloudTabs, moduleLive],
  );

  const activeCloudAccountId = useMemo(() => {
    const tab = cloudTabs.find((item) => item.id === activeTabId);
    return tab ? tab.serverId : null;
  }, [activeTabId, cloudTabs]);

  return (
    <>
      <ModuleWorkspaceLayout
        className="cloud-panel"
        leftColumnTitle={t("shell.nav.cloud")}
        leftPreset="server"
        tagModuleKey="cloud"
        leftHeaderActions={<ModuleLeftHeaderActions moduleKey="cloud" />}
        leftSidebar={
          <VerticalSplitSidebar className="server-panel-sidebar">
            <ScopedSearch
              className="server-tree-scoped-search"
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder={t("server.sidebar.search")}
            >
              <CloudTreeSidebar
                accounts={cloudAccounts}
                activeAccountId={activeCloudAccountId}
                activeNavKey={activeCloudNavKey}
                searchQuery={searchQuery}
                onNavigate={handleNavigateCloud}
                onCreateAccount={handleCreateCloud}
                onEditAccount={handleEditCloud}
                onDeleteAccount={handleDeleteCloud}
                section={{
                  title: t("server.cloud.sidebar.title"),
                  expanded: true,
                  onToggle: () => undefined,
                }}
              />
            </ScopedSearch>
          </VerticalSplitSidebar>
        }
      >
        <ModuleSegmentDock
          className="server-module-dock"
          variant="workspace"
          dockScope="cloud-panel"
          tabs={moduleDockTabs}
          activeTabId={activeTabId ?? ""}
          onActiveTabChange={setActiveTabId}
          onCloseTab={handleCloseTab}
          onTabContextMenu={(event: ReactMouseEvent, tabId: string, index: number) => {
            event.preventDefault();
            setTabCtxMenu({ x: event.clientX, y: event.clientY, tabId, index });
          }}
          enabled={isActiveRoute}
          stickyVisit
          contentSuspended={!moduleLive}
          savedLayout={dockLayout}
          onSavedLayoutChange={setDockLayout}
          renderPanel={renderCloudPanel}
          emptyContent={
            <WorkspaceEmptyPage
              title={t("shell.nav.cloud")}
              prompt={t("cloud.empty.prompt")}
              actions={
                <Button type="button" variant="primary" onClick={handleCreateCloud}>
                  {t("server.cloud.sidebar.addAccount")}
                </Button>
              }
            />
          }
        />
      </ModuleWorkspaceLayout>

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

      <CloudConnectionDialog
        open={showCloudDialog}
        onClose={() => setShowCloudDialog(false)}
        onSaved={() => setShowCloudDialog(false)}
        editConnection={editCloudConnection}
      />
    </>
  );
}
