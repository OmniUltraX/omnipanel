import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  ModuleSegmentDock,
  closeDockTabNow,
  type DockableTab,
} from "../../components/dock";
import { ModuleWorkspaceLayout } from "../../components/workspace";
import { ModuleLeftHeaderActions } from "../../components/ai/ModuleLeftHeaderActions";
import { WorkspaceEmptyPage } from "../../components/ui/workspace/WorkspaceEmptyPage";
import {
  buildTabCloseMenuItems,
  ContextMenu,
  type TabContextMenuAction,
} from "../../components/ui/menu";
import { useModuleRouteActive } from "../../lib/useModuleRouteActive";
import { useI18n } from "../../i18n";
import { useUiFollowConsumer } from "../../lib/ai/uiFollow";
import { SshHostSidebar } from "./ssh/SshHostSidebar";
import { SshSidebarLinkageProvider } from "./ssh/SshSidebarLinkageContext";
import { HostDetailPanel } from "./ssh/components/HostDetailPanel";
import { useSshHostWorkspace } from "./ssh/hooks/useSshHostWorkspace";
import { useSshHostResources } from "../../stores/connectionStore";
import { useSshSelectionStore } from "./ssh/stores/sshSelectionStore";
import { useSshActiveHostStore } from "./ssh/stores/sshActiveHostStore";
import { useSshPanelDockStore } from "../../stores/sshPanelDockStore";
import {
  removeTabFromSshLayout,
  useSshDockLayoutStore,
} from "../../stores/sshDockLayoutStore";

export function SshPanel() {
  const { t } = useI18n();
  const { isActiveRoute } = useModuleRouteActive("ssh");
  const sshResources = useSshHostResources();
  const { activeHostId, handleSelectHost } = useSshHostWorkspace(sshResources);
  const selectionMode = useSshSelectionStore((s) => s.selectionMode);
  const selectedIds = useSshSelectionStore((s) => s.selectedIds);

  const dockTabs = useSshPanelDockStore((s) => s.tabs);
  const activeTabId = useSshPanelDockStore((s) => s.activeTabId);
  const setActiveTabId = useSshPanelDockStore((s) => s.setActiveTabId);
  const closeTab = useSshPanelDockStore((s) => s.closeTab);
  const promoteTab = useSshPanelDockStore((s) => s.promoteTab);
  const removeHostTabs = useSshPanelDockStore((s) => s.removeHostTabs);
  const selectHost = useSshPanelDockStore((s) => s.selectHost);
  const setActiveHostId = useSshActiveHostStore((s) => s.setActiveHostId);

  const savedLayout = useSshDockLayoutStore((s) => s.savedLayout);
  const setSavedLayout = useSshDockLayoutStore((s) => s.setSavedLayout);

  const [tabCtxMenu, setTabCtxMenu] = useState<{
    x: number;
    y: number;
    tabId: string;
    index: number;
  } | null>(null);

  const resourceById = useMemo(() => {
    const map = new Map(sshResources.map((resource) => [resource.id, resource]));
    return map;
  }, [sshResources]);

  const validHostIds = useMemo(
    () => new Set(sshResources.map((resource) => resource.id)),
    [sshResources],
  );

  useEffect(() => {
    if (!isActiveRoute) {
      setTabCtxMenu(null);
    }
  }, [isActiveRoute]);

  useEffect(() => {
    const pruneStaleTabs = () => {
      const tabs = useSshPanelDockStore.getState().tabs;
      const staleHostIds = [
        ...new Set(tabs.filter((tab) => !validHostIds.has(tab.hostId)).map((tab) => tab.hostId)),
      ];
      for (const hostId of staleHostIds) {
        removeHostTabs(hostId);
      }
    };

    if (useSshPanelDockStore.persist.hasHydrated()) {
      pruneStaleTabs();
      return;
    }
    return useSshPanelDockStore.persist.onFinishHydration(pruneStaleTabs);
  }, [removeHostTabs, validHostIds]);

  useEffect(() => {
    if (!activeTabId) return;
    const hostId = dockTabs.find((tab) => tab.id === activeTabId)?.hostId;
    if (hostId && hostId !== activeHostId) {
      setActiveHostId(hostId);
    }
  }, [activeHostId, activeTabId, dockTabs, setActiveHostId]);

  useUiFollowConsumer("ssh", useCallback((intent) => {
    switch (intent.type) {
      case "openConnection": {
        if (intent.module !== "ssh") return false;
        const resource = resourceById.get(intent.resourceId);
        if (!resource) return false;
        selectHost(resource.id, resource.name, "permanent");
        setActiveHostId(resource.id);
        return true;
      }
      case "revealSftpPath": {
        const resource = resourceById.get(intent.resourceId);
        if (!resource) return false;
        selectHost(resource.id, resource.name, "permanent");
        setActiveHostId(resource.id);
        return true;
      }
      default:
        return false;
    }
  }, [resourceById, selectHost, setActiveHostId]));

  const moduleDockTabs = useMemo(
    (): DockableTab[] =>
      dockTabs
        .map((tab) => {
          const resource = resourceById.get(tab.hostId);
          if (!resource) return null;
          return {
            id: tab.id,
            label: resource.name || tab.label,
            panelType: "ssh-host",
            icon: "server" as const,
            closable: true,
            preview: tab.preview,
            tooltip: resource.subtitle ?? resource.name,
          };
        })
        .filter((tab): tab is NonNullable<typeof tab> => tab != null),
    [dockTabs, resourceById],
  );

  const handleCloseTab = useCallback(
    (tabId: string) => {
      closeDockTabNow({
        removeTabSync: () => {
          closeTab(tabId);
          setSavedLayout(
            removeTabFromSshLayout(useSshDockLayoutStore.getState().savedLayout, tabId),
          );
        },
      });
    },
    [closeTab, setSavedLayout],
  );

  const handleDockTabContextMenu = useCallback(
    (event: ReactMouseEvent, tabId: string, index: number) => {
      event.preventDefault();
      setTabCtxMenu({ x: event.clientX, y: event.clientY, tabId, index });
    },
    [],
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

  const handleActiveTabChange = useCallback(
    (tabId: string) => {
      setActiveTabId(tabId);
      const hostId = dockTabs.find((tab) => tab.id === tabId)?.hostId ?? null;
      if (hostId) {
        setActiveHostId(hostId);
      }
    },
    [dockTabs, setActiveHostId, setActiveTabId],
  );

  const handleTabDoubleClick = useCallback(
    (tabId: string) => {
      promoteTab(tabId);
    },
    [promoteTab],
  );

  const renderHostPanel = useCallback((tabId: string) => {
    const tab = useSshPanelDockStore.getState().tabs.find((item) => item.id === tabId);
    if (!tab) {
      return <div className="ssh-host-tab-pane" aria-hidden />;
    }
    return (
      <div className="ssh-host-tab-pane">
        <HostDetailPanel hostId={tab.hostId} key={tab.hostId} />
      </div>
    );
  }, []);

  const sidebarLinkageValue = useMemo(() => ({ activeHostId }), [activeHostId]);

  return (
    <SshSidebarLinkageProvider value={sidebarLinkageValue}>
      <ModuleWorkspaceLayout
        className="ssh-module-layout"
        leftColumnTitle={t("routes.ssh")}
        leftPreset="host"
        tagModuleKey="ssh"
        leftHeaderActions={<ModuleLeftHeaderActions moduleKey="ssh" />}
        leftSidebar={
          <SshHostSidebar
            resources={sshResources}
            onSelectHost={handleSelectHost}
            selectionMode={selectionMode}
            selectedIds={selectedIds}
            tagModuleKey="ssh"
          />
        }
      >
        <ModuleSegmentDock
          className="ssh-module-dock"
          variant="workspace"
          dockScope="ssh-panel"
          tabs={moduleDockTabs}
          activeTabId={activeTabId ?? ""}
          onActiveTabChange={handleActiveTabChange}
          onCloseTab={handleCloseTab}
          onTabContextMenu={handleDockTabContextMenu}
          onTabDoubleClick={handleTabDoubleClick}
          enabled={isActiveRoute}
          stickyVisit
          contentSuspended={!isActiveRoute}
          savedLayout={dockTabs.length === 0 ? null : savedLayout}
          onSavedLayoutChange={setSavedLayout}
          renderPanel={renderHostPanel}
          emptyContent={
            <WorkspaceEmptyPage
              title={t("routes.ssh")}
              prompt={t("ssh.empty.selectHost")}
            />
          }
        />
      </ModuleWorkspaceLayout>

      {isActiveRoute && tabCtxMenu ? (
        <ContextMenu
          items={buildTabCloseMenuItems(
            t,
            moduleDockTabs.length,
            tabCtxMenu.index,
            handleTabContextAction,
          )}
          position={{ x: tabCtxMenu.x, y: tabCtxMenu.y }}
          onClose={() => setTabCtxMenu(null)}
        />
      ) : null}
    </SshSidebarLinkageProvider>
  );
}
