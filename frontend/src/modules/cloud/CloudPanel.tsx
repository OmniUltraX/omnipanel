import { useCallback, useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { ModuleSegmentDock, openDockTabNow, closeDockTabNow } from "../../components/dock";
import type { DockHeaderIconKind } from "../../components/dock/DockHeaderIcon";
import { ModuleWorkspaceLayout } from "../../components/workspace";
import { ModuleLeftHeaderActions } from "../../components/ai/ModuleLeftHeaderActions";
import { WorkspaceEmptyPage } from "../../components/ui/workspace/WorkspaceEmptyPage";
import { WorkbenchActionButton } from "../../components/ui/primitives/WorkbenchActionButton";
import { ContextMenu, buildTabCloseMenuItems, type TabContextMenuAction } from "../../components/ui/menu";
import { useModuleRouteActive } from "../../lib/useModuleRouteActive";
import { useConnectionStore } from "../../stores/connectionStore";
import { useI18n } from "../../i18n";
import { appConfirm } from "../../lib/appConfirm";
import { CloudConnectionDialog } from "./CloudConnectionDialog";
import { CloudDockPanel } from "./CloudDockPanel";
import { CloudTreeSidebar } from "./CloudTreeSidebar";
import { cloudBrandKind, cloudCapabilityLabel, connectionToCloudAccount, type CloudAccount } from "./cloudForm";
import { makeCloudTreeKey, type CloudSidebarNavTarget } from "./cloudWorkspaceTabs";
import { CONNECTION_TAG_KINDS } from "../tags/tagKinds";
import { passTagFilter, useModuleTagFilter } from "../tags/useModuleTagFilter";
import type { Connection } from "../../ipc/bindings";
import { useCloudDockStore } from "../../stores/cloudDockStore";
import { useCloudInventoryStore } from "../../stores/cloudInventoryStore";
import { useUiFollowConsumer } from "../../lib/ai/uiFollow";
import { VerticalSplitSidebar } from "../../components/ui/sidebar/VerticalSplitSidebar";
import { ScopedSearch } from "../../components/ui/search";
import {
  cloudRegionRowLabel,
  fallbackCloudRegions,
  loadCloudAccountRegions,
} from "./cloudRegionDiscovery";
import { usePluginRuntimeStore } from "../../stores/pluginRuntimeStore";
import { resolveCloudQueryRegions } from "./cloudResourceApi";

export function CloudPanel() {
  const { t } = useI18n();
  const { isActiveRoute, moduleLive } = useModuleRouteActive("cloud");
  const connections = useConnectionStore((s) => s.connections);
  const removeConn = useConnectionStore((s) => s.remove);
  const tagAllowedIds = useModuleTagFilter("cloud", CONNECTION_TAG_KINDS);
  usePluginRuntimeStore((s) => s.items);
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

  const dockTabs = useCloudDockStore((s) => s.tabs);
  const activeTabId = useCloudDockStore((s) => s.activeTabId);
  const dockLayout = useCloudDockStore((s) => s.dockLayout);
  const selectAccount = useCloudDockStore((s) => s.selectAccount);
  const selectResources = useCloudDockStore((s) => s.selectResources);
  const selectResource = useCloudDockStore((s) => s.selectResource);
  const closeTab = useCloudDockStore((s) => s.closeTab);
  const setActiveTabId = useCloudDockStore((s) => s.setActiveTabId);
  const setDockLayout = useCloudDockStore((s) => s.setDockLayout);
  const removeAccountTabs = useCloudDockStore((s) => s.removeAccountTabs);

  useUiFollowConsumer("cloud", useCallback((intent) => {
    if (intent.type === "openConnection") {
      const conn = useConnectionStore.getState().connections.find((c) => c.id === intent.resourceId);
      if (conn?.kind === "cloud") {
        selectAccount(intent.resourceId, "permanent");
        return true;
      }
    }
    return false;
  }, [selectAccount]));

  const [showCloudDialog, setShowCloudDialog] = useState(false);
  const [editCloudConnection, setEditCloudConnection] = useState<Connection | undefined>();
  const [activeCloudNavKey, setActiveCloudNavKey] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedRegions, setSelectedRegions] = useState<string[]>([]);
  const [inspectorRowId, setInspectorRowId] = useState<string | null>(null);
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

  useEffect(() => {
    const validIds = new Set(cloudAccounts.map((account) => account.id));
    for (const tab of dockTabs) {
      if (!validIds.has(tab.accountId)) {
        removeAccountTabs(tab.accountId);
      }
    }
  }, [cloudAccounts, dockTabs, removeAccountTabs]);

  const handleNavigateCloud = useCallback(
    (target: CloudSidebarNavTarget, mode: "preview" | "permanent" = "preview") => {
      openDockTabNow({
        applyTabSync: () => {
          if (target.kind === "account") {
            selectAccount(target.accountId, mode);
          } else if (target.kind === "capability") {
            selectResources(target.accountId, target.capability, mode);
          } else {
            selectResource(
              target.accountId,
              target.capability,
              target.resourceId,
              target.regionId ?? "",
              mode,
            );
          }
          setActiveCloudNavKey(makeCloudTreeKey(target));
        },
      });
    },
    [selectAccount, selectResource, selectResources],
  );

  useEffect(() => {
    const tab = dockTabs.find((item) => item.id === activeTabId);
    if (!tab) {
      setActiveCloudNavKey(null);
      return;
    }
    if (tab.kind === "account") {
      setActiveCloudNavKey(makeCloudTreeKey({ kind: "account", accountId: tab.accountId }));
    } else if (tab.kind === "resources") {
      setActiveCloudNavKey(
        makeCloudTreeKey({ kind: "capability", accountId: tab.accountId, capability: tab.capability }),
      );
    } else {
      setActiveCloudNavKey(
        makeCloudTreeKey({
          kind: "resource",
          accountId: tab.accountId,
          capability: tab.capability,
          resourceId: tab.resourceId,
        }),
      );
    }
  }, [activeTabId, dockTabs]);

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
        removeAccountTabs(id);
        useCloudInventoryStore.getState().removeAccount(id);
        await removeConn(id);
      }
    },
    [removeConn, removeAccountTabs, t],
  );

  const activeAccountId = useMemo(() => {
    const tab = dockTabs.find((item) => item.id === activeTabId);
    return tab ? tab.accountId : null;
  }, [activeTabId, dockTabs]);

  const activeAccount = activeAccountId ? cloudById.get(activeAccountId) ?? null : null;

  const cachedLiveRegions = useCloudInventoryStore((s) =>
    activeAccountId ? s.byAccount[activeAccountId]?.regions?.regions : undefined,
  );

  useEffect(() => {
    if (!activeAccount) return;
    void loadCloudAccountRegions(activeAccount.id).catch(() => undefined);
  }, [activeAccount]);

  const liveRegions = useMemo(() => {
    if (cachedLiveRegions && cachedLiveRegions.length > 0) return cachedLiveRegions;
    return fallbackCloudRegions(activeAccount?.regions ?? []);
  }, [activeAccount, cachedLiveRegions]);

  const liveRegionIds = useMemo(
    () => liveRegions.map((region) => region.regionId),
    [liveRegions],
  );

  const regionOptions = useMemo(
    () => liveRegions.map((region) => ({ value: region.regionId, label: cloudRegionRowLabel(region) })),
    [liveRegions],
  );

  const moduleDockTabs = useMemo(
    () =>
      dockTabs
        .map((tab) => {
          const account = cloudById.get(tab.accountId);
          if (!account) return null;
          let label = account.name;
          if (tab.kind === "resources") {
            label = `${cloudCapabilityLabel(t, tab.capability, account.pluginId)}@${account.name}`;
          } else if (tab.kind === "resource") {
            label = `${tab.resourceId}@${account.name}`;
          }
          return {
            id: tab.id,
            label,
            panelType: "cloud-panel",
            icon: cloudBrandKind(account.pluginId) as DockHeaderIconKind,
            closable: true,
            preview: tab.preview,
            tooltip: account.accessKeyId,
          };
        })
        .filter((tab): tab is NonNullable<typeof tab> => tab != null),
    [cloudById, dockTabs, t],
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
      const tab = dockTabs.find((item) => item.id === tabId);
      if (!tab) return <div className="server-panel-tab-pane" aria-hidden />;
      const account = cloudById.get(tab.accountId);
      if (!account) return <div className="server-panel-tab-pane" aria-hidden />;
      const queryRegions = resolveCloudQueryRegions(
        selectedRegions,
        account.id === activeAccountId ? liveRegionIds : [],
        account.regions,
      );
      return (
        <CloudDockPanel
          tab={tab}
          account={account}
          selectedRegions={queryRegions}
          inspectorRowId={inspectorRowId}
          onOpenCapability={(capability) =>
            handleNavigateCloud({ kind: "capability", accountId: account.id, capability }, "permanent")
          }
          onSelectRow={(capability, resourceId, regionId) => {
            setInspectorRowId(resourceId);
            handleNavigateCloud(
              { kind: "resource", accountId: account.id, capability, resourceId, regionId },
              "preview",
            );
          }}
          onOpenRow={(capability, resourceId, regionId) =>
            handleNavigateCloud(
              { kind: "resource", accountId: account.id, capability, resourceId, regionId },
              "permanent",
            )
          }
        />
      );
    },
    [activeAccountId, cloudById, dockTabs, handleNavigateCloud, inspectorRowId, liveRegionIds, selectedRegions],
  );

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
                activeAccountId={activeAccountId}
                activeNavKey={activeCloudNavKey}
                searchQuery={searchQuery}
                selectedRegions={selectedRegions}
                liveRegionIds={liveRegionIds}
                regionOptions={regionOptions}
                onSelectedRegionsChange={setSelectedRegions}
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
                <WorkbenchActionButton onClick={handleCreateCloud}>
                  {t("server.cloud.sidebar.addAccount")}
                </WorkbenchActionButton>
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
