import { useCallback, useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useLocation } from "react-router-dom";
import {
  useTerminalStore,
  type TerminalTab,
} from "../../stores/terminalStore";
import { disposeTabBackendSessions } from "../../hooks/useTerminal";
import { clearPaneBackendPending } from "../../hooks/useTerminal";
import {
  resolveResourceById,
  useSshHostResources,
} from "../../stores/connectionStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useI18n } from "../../i18n";
import type { TopbarTabDef } from "../../stores/topbarStore";
import { navigateToPath } from "../../lib/terminalSession";
import { LOCAL_TERMINAL_RESOURCE_ID } from "./paneResource";
import { TerminalTabDockPane } from "./TerminalTabDockPane";
import { clearTerminalPaneSender } from "./terminalPaneSenders";
import { useWorkspaceBottomDockStore } from "../../stores/workspaceBottomDockStore";
import {
  copyTerminalTabToWorkspaceSnapshot,
  moveTerminalTabToWorkspaceSnapshot,
  addSnapshotToWorkspace,
} from "../../lib/workspaceTabActions";
import { subscribeDockviewTransfer } from "../../lib/dockviewRegistry";
import { ModuleSegmentDock } from "../../components/dock";
import {
  removeTabFromTerminalLayout,
  useTerminalDockLayoutStore,
} from "../../stores/terminalDockLayoutStore";
import { ContextMenu } from "../../components/ui/ContextMenu";
import {
  buildTabCloseMenuItems,
  type TabContextMenuAction,
} from "../../components/ui/contextMenuItems";

function tabLabel(tab: TerminalTab, fallbackName?: string) {
  const resource = resolveResourceById(tab.session.resourceId);
  return resource?.name ?? tab.title ?? fallbackName ?? tab.session.resourceId;
}

function topbarTabStatus(
  status: TerminalTab["status"],
): TopbarTabDef["status"] {
  if (status === "connected") return "connected";
  if (status === "connecting") return "connecting";
  if (status === "disconnected") return "offline";
  return "idle";
}

export function TerminalPanel() {
  const { t } = useI18n();
  const location = useLocation();
  const isActiveRoute = location.pathname === "/module/terminal";
  const allTabs = useTerminalStore((state) => state.tabs);
  const tabs = useMemo(
    () => allTabs.filter((tab) => !tab.workspaceOnly),
    [allTabs]
  );
  const activeTabId = useTerminalStore((state) => state.activeTabId);
  const removeTab = useTerminalStore((state) => state.removeTab);
  const setActiveTab = useTerminalStore((state) => state.setActiveTab);
  const openOrFocusLocalTab = useTerminalStore((state) => state.openOrFocusLocalTab);
  const addLocalTerminalTab = useTerminalStore((state) => state.addLocalTerminalTab);
  const addSshTerminalTab = useTerminalStore((state) => state.addSshTerminalTab);
  const sshHosts = useSshHostResources();

  const dockLayout = useTerminalDockLayoutStore((state) => state.savedLayout);
  const setDockLayout = useTerminalDockLayoutStore((state) => state.setSavedLayout);

  const workspaceActiveResourceId = useWorkspaceStore(
    (state) => state.activeResourceId,
  );
  const workspaceActiveResource =
    resolveResourceById(workspaceActiveResourceId) ??
    resolveResourceById(LOCAL_TERMINAL_RESOURCE_ID);
  const selectResource = useWorkspaceStore((state) => state.selectResource);

  const activeWorkspaceId = useWorkspaceStore((s) => s.workspace.id);

  useEffect(() => {
    return subscribeDockviewTransfer((meta) => {
      if (!meta.newPanelId.startsWith("terminal:")) return;
      if (!meta.originScope.startsWith("workspace-bottom-")) return;
      const prefix = `${meta.originScope}:`;
      const originTerminalId = meta.originPanelId.startsWith(prefix)
        ? meta.originPanelId.slice(prefix.length)
        : meta.originPanelId;
      setActiveTab(originTerminalId);
    });
  }, [removeDockedOrigin, setActiveTab]);

  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    tabId: string;
    index: number;
  } | null>(null);

  useEffect(() => {
    if (!isActiveRoute) return;
    if (tabs.length === 0) {
      const id = openOrFocusLocalTab(workspaceActiveResource?.name ?? "本地终端");
      setActiveTab(id);
      return;
    }
    if (!activeTabId || !tabs.some((tab) => tab.id === activeTabId)) {
      setActiveTab(tabs[0].id);
    }
  }, [
    isActiveRoute,
    tabs,
    activeTabId,
    openOrFocusLocalTab,
    setActiveTab,
    workspaceActiveResource?.name,
  ]);

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? null,
    [tabs, activeTabId],
  );

  useEffect(() => {
    if (!isActiveRoute || !activeTab?.session.resourceId) return;
    if (activeTab.session.resourceId !== workspaceActiveResourceId) {
      selectResource(activeTab.session.resourceId);
    }
  }, [
    activeTab?.session.resourceId,
    isActiveRoute,
    selectResource,
    workspaceActiveResourceId,
  ]);

  const handleCloseTab = useCallback(
    (id: string) => {
      clearTerminalPaneSender(id);
      clearPaneBackendPending(id);
      disposeTabBackendSessions(id);
      const currentLayout = useTerminalDockLayoutStore.getState().savedLayout;
      setDockLayout(removeTabFromTerminalLayout(currentLayout, id));
      removeTab(id);
    },
    [removeTab, setDockLayout],
  );

  const visibleTabs = useMemo(
    () =>
      tabs.filter(
        (tab) => !tab.workspaceOnly,
      ),
    [tabs],
  );

  const dockTabs = useMemo(
    () =>
      visibleTabs.map((tab) => ({
        id: tab.id,
        label: tabLabel(tab),
        panelType: "terminal-session",
        closable: true,
        status: topbarTabStatus(tab.status),
      })),
    [visibleTabs],
  );

  const addMenuItems = useMemo(
    () => [
      {
        id: LOCAL_TERMINAL_RESOURCE_ID,
        label: t("terminal.newSession.local"),
        subtitle: t("terminal.newSession.localDesc"),
      },
      ...sshHosts.map((host) => ({
        id: host.id,
        label: host.name,
        subtitle: host.subtitle,
      })),
      {
        id: "manage-hosts",
        label: t("terminal.newSession.manageHosts"),
        subtitle: t("terminal.newSession.manageHostsDesc"),
        dividerBefore: true,
      },
    ],
    [sshHosts, t],
  );

  const handleTopbarAdd = useCallback(() => {
    const name = workspaceActiveResource?.name ?? t("terminal.newSession.local");
    const id = addLocalTerminalTab(name);
    setActiveTab(id);
  }, [addLocalTerminalTab, setActiveTab, workspaceActiveResource?.name, t]);

  const handleTopbarAddMenuSelect = useCallback(
    (id: string) => {
      if (id === "manage-hosts") {
        navigateToPath("/module/ssh");
        return;
      }
      if (id === LOCAL_TERMINAL_RESOURCE_ID) {
        const tabId = addLocalTerminalTab(t("terminal.newSession.local"));
        selectResource(LOCAL_TERMINAL_RESOURCE_ID);
        setActiveTab(tabId);
        return;
      }
      const host = sshHosts.find((item) => item.id === id);
      if (host) {
        const tabId = addSshTerminalTab(host.id, host.name);
        selectResource(host.id);
        setActiveTab(tabId);
      }
    },
    [
      addLocalTerminalTab,
      addSshTerminalTab,
      selectResource,
      setActiveTab,
      sshHosts,
      t,
    ],
  );

  const handleDockTabContextMenu = useCallback(
    (event: ReactMouseEvent, tabId: string, index: number) => {
      event.preventDefault();
      setCtxMenu({ x: event.clientX, y: event.clientY, tabId, index });
    },
    [],
  );

  const handleContextAction = useCallback(
    (action: TabContextMenuAction) => {
      if (!ctxMenu) return;
      if (action === "rename") {
        setCtxMenu(null);
        return;
      }
      if (action === "copyToWorkspace") {
        if (!activeWorkspaceId) return;
        const ctxTab = visibleTabs.find((tab) => tab.id === ctxMenu.tabId);
        if (ctxTab) {
          addSnapshotToWorkspace(activeWorkspaceId, copyTerminalTabToWorkspaceSnapshot(ctxTab));
        }
        setCtxMenu(null);
        return;
      }
      if (action === "moveToWorkspace") {
        if (!activeWorkspaceId) return;
        const ctxTab = visibleTabs.find((tab) => tab.id === ctxMenu.tabId);
        if (ctxTab) {
          useTerminalStore.getState().setTabWorkspaceOnly(ctxTab.id, true);
          addSnapshotToWorkspace(activeWorkspaceId, moveTerminalTabToWorkspaceSnapshot(ctxTab));
        }
        setCtxMenu(null);
        return;
      }
      const idx = ctxMenu.index;
      const tabList = visibleTabs;
      if (action === "close") {
        handleCloseTab(ctxMenu.tabId);
      } else if (action === "closeLeft") {
        for (let i = idx - 1; i >= 0; i--) handleCloseTab(tabList[i].id);
      } else if (action === "closeRight") {
        for (let i = tabList.length - 1; i > idx; i--) handleCloseTab(tabList[i].id);
      } else if (action === "closeOthers") {
        for (let i = tabList.length - 1; i >= 0; i--) {
          if (i !== idx) handleCloseTab(tabList[i].id);
        }
      } else if (action === "closeAll") {
        for (let i = tabList.length - 1; i >= 0; i--) handleCloseTab(tabList[i].id);
      }
      setCtxMenu(null);
    },
    [ctxMenu, handleCloseTab, visibleTabs, activeWorkspaceId],
  );

  const renderDockPanel = useCallback(
    (tabId: string) => (
      <TerminalTabDockPane
        tabId={tabId}
        isActive={tabId === activeTabId}
        onActivate={() => setActiveTab(tabId)}
      />
    ),
    [activeTabId, setActiveTab],
  );

  const addTabConfig = useMemo(
    () => ({
      show: isActiveRoute,
      title: t("shell.topbar.newTab"),
      onAdd: handleTopbarAdd,
      menuItems: addMenuItems,
      onMenuSelect: handleTopbarAddMenuSelect,
    }),
    [
      addMenuItems,
      handleTopbarAdd,
      handleTopbarAddMenuSelect,
      isActiveRoute,
      t,
    ],
  );

  const handleCtrlCopyTab = useCallback(
    (tabId: string) => {
      if (!activeWorkspaceId) return;
      const ctxTab = visibleTabs.find((tab) => tab.id === tabId);
      if (!ctxTab) {
        return;
      }
      addSnapshotToWorkspace(
        activeWorkspaceId,
        copyTerminalTabToWorkspaceSnapshot(ctxTab),
      );
    },
    [visibleTabs, activeWorkspaceId],
  );

  return (
    <>
      <ModuleSegmentDock
        className="terminal-module-dock"
        dockScope="terminal"
        acceptExternalDrops
        tabs={dockTabs}
        activeTabId={activeTabId ?? visibleTabs[0]?.id ?? ""}
        onActiveTabChange={setActiveTab}
        onCloseTab={handleCloseTab}
        savedLayout={dockLayout}
        onSavedLayoutChange={setDockLayout}
        renderPanel={renderDockPanel}
        onTabContextMenu={handleDockTabContextMenu}
        onCtrlCopyTab={handleCtrlCopyTab}
        addTabConfig={addTabConfig}
        enabled={isActiveRoute}
        emptyContent={
          <div className="term-workspace__empty">{t("terminal.newSession.local")}</div>
        }
      />
      {ctxMenu && (() => {
        const closeItems = buildTabCloseMenuItems(
          t,
          visibleTabs.length,
          ctxMenu.index,
          handleContextAction,
          { showWorkspaceActions: true },
        );
        return (
          <ContextMenu
            items={closeItems}
            position={{ x: ctxMenu.x, y: ctxMenu.y }}
            onClose={() => setCtxMenu(null)}
          />
        );
      })()}
    </>
  );
}
