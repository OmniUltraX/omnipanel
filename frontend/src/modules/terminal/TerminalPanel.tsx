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
import { useWorkspaceStore, onWorkspaceSwitch } from "../../stores/workspaceStore";
import { useI18n } from "../../i18n";
import type { TopbarTabDef } from "../../stores/topbarStore";
import { navigateToPath } from "../../lib/terminalSession";
import { LOCAL_TERMINAL_RESOURCE_ID } from "./paneResource";
import { TerminalTabDockPane } from "./TerminalTabDockPane";
import { clearTerminalPaneSender } from "./terminalPaneSenders";
import { useWorkspaceBottomDockStore } from "../../stores/workspaceBottomDockStore";
import { useWorkspaceTabStore, type TerminalTabSnapshot } from "../../stores/workspaceTabStore";
import { terminalTabToSnapshot, buildCopyToWorkspaceMenuItems, buildMoveToWorkspaceMenuItems, addSnapshotToWorkspace } from "../../lib/workspaceTabActions";
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
  const isActiveRoute = location.pathname === "/terminal";
  const tabs = useTerminalStore((state) => state.tabs);
  const activeTabId = useTerminalStore((state) => state.activeTabId);
  const removeTab = useTerminalStore((state) => state.removeTab);
  const setActiveTab = useTerminalStore((state) => state.setActiveTab);
  const openOrFocusLocalTab = useTerminalStore((state) => state.openOrFocusLocalTab);
  const openOrFocusSshTab = useTerminalStore((state) => state.openOrFocusSshTab);
  const addLocalTerminalTab = useTerminalStore((state) => state.addLocalTerminalTab);
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

  const isOriginDocked = useWorkspaceBottomDockStore((s) => s.isOriginDocked);
  const removeDockedOrigin = useWorkspaceBottomDockStore((s) => s.removeDockedOrigin);
  const allWorkspaces = useWorkspaceStore((s) => s.workspaces);
  const currentWorkspaceId = useWorkspaceStore((s) => s.workspace.id);
  const wsTabStore = useWorkspaceTabStore;

  useEffect(() => {
    return subscribeDockviewTransfer((meta) => {
      if (!meta.newPanelId.startsWith("terminal:")) return;
      if (!meta.originScope.startsWith("workspace-bottom-")) return;
      const prefix = `${meta.originScope}:`;
      const originTerminalId = meta.originPanelId.startsWith(prefix)
        ? meta.originPanelId.slice(prefix.length)
        : meta.originPanelId;
      removeDockedOrigin("terminal", originTerminalId);
      setActiveTab(originTerminalId);
    });
  }, [removeDockedOrigin, setActiveTab]);

  // 工作区切换时：保存当前终端 tab 快照 → 恢复目标工作区的快照
  useEffect(() => {
    return onWorkspaceSwitch(({ prevWorkspaceId, nextWorkspaceId }) => {
      const store = useTerminalStore.getState();
      const wsTabStoreState = wsTabStore.getState();

      // 保存当前终端 tabs 到旧工作区
      const snapshots = store.tabs.map(terminalTabToSnapshot);
      wsTabStoreState.saveTabs(prevWorkspaceId, snapshots);

      // 恢复目标工作区的终端 tabs
      const targetSnapshots = wsTabStoreState.getTabs(nextWorkspaceId).filter(
        (s): s is TerminalTabSnapshot => s.module === "terminal",
      );
      // 目标工作区没有保存过快照 → 保留当前 tab（新工作区继承）
      if (targetSnapshots.length === 0) return;

      // 有快照 → 清空当前 tabs 并恢复
      for (const tab of [...store.tabs]) {
        clearTerminalPaneSender(tab.id);
        clearPaneBackendPending(tab.id);
        disposeTabBackendSessions(tab.id);
        store.removeTab(tab.id);
      }
      for (const snap of targetSnapshots) {
        store.addTab({
          id: snap.id,
          title: snap.label,
          session: {
            type: snap.sessionType,
            resourceId: snap.resourceId,
            shellLabel: snap.shellLabel,
            cwd: snap.cwd,
            purpose: snap.purpose,
            commandPack: [],
          },
        });
      }
      if (targetSnapshots.length > 0) {
        store.setActiveTab(targetSnapshots[0].id);
      }
    });
  }, []);

  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    tabId: string;
    index: number;
  } | null>(null);

  // 进入模块时若没有任何 Tab，则自动建一个本地终端
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

  // 同步 workspace 资源选中（仅当面板处于激活路由时）
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
    () => tabs.filter((tab) => !isOriginDocked("terminal", tab.id)),
    [tabs, isOriginDocked],
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
        navigateToPath("/ssh");
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
        const tabId = openOrFocusSshTab(host.id, host.name);
        selectResource(host.id);
        setActiveTab(tabId);
      }
    },
    [
      addLocalTerminalTab,
      openOrFocusSshTab,
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
    [ctxMenu, handleCloseTab, visibleTabs],
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
        addTabConfig={addTabConfig}
        enabled={isActiveRoute}
        emptyContent={
          <div className="term-workspace__empty">{t("terminal.newSession.local")}</div>
        }
      />
      {ctxMenu && (() => {
        const ctxTab = visibleTabs.find((tab) => tab.id === ctxMenu.tabId);
        const snapshot = ctxTab ? terminalTabToSnapshot(ctxTab) : null;
        const closeItems = buildTabCloseMenuItems(
          t,
          visibleTabs.length,
          ctxMenu.index,
          handleContextAction,
        );
        const wsCopyItems = snapshot ? buildCopyToWorkspaceMenuItems({
          workspaces: allWorkspaces,
          currentWorkspaceId,
          snapshot,
          onCopyToCurrent: () => {
            if (!ctxTab) return;
            const newId = addLocalTerminalTab(ctxTab.title);
            const created = useTerminalStore.getState().tabs.find((tab) => tab.id === newId);
            if (created) {
              addSnapshotToWorkspace(currentWorkspaceId, terminalTabToSnapshot(created));
            }
            setActiveTab(newId);
          },
        }) : [];
        const wsMoveItems = snapshot ? buildMoveToWorkspaceMenuItems(t, {
          workspaces: allWorkspaces,
          currentWorkspaceId,
          snapshot,
          onMoveToOther: () => handleCloseTab(ctxMenu.tabId),
        }) : [];
        const allItems = [
          ...closeItems,
          { id: "ws-sep-before", separator: true, label: "" },
          {
            id: "ws-copy",
            label: t("shell.workspace.copyTo"),
            children: wsCopyItems,
          },
          {
            id: "ws-move",
            label: t("shell.workspace.moveTo"),
            children: wsMoveItems,
          },
        ];
        return (
          <ContextMenu
            items={allItems}
            position={{ x: ctxMenu.x, y: ctxMenu.y }}
            onClose={() => setCtxMenu(null)}
          />
        );
      })()}
    </>
  );
}
