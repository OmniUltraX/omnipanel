import { useCallback, useEffect, useMemo, useState, type ComponentProps, type MouseEvent as ReactMouseEvent } from "react";
import { useLocation } from "react-router-dom";
import {
  useTerminalStore,
  type TerminalTab,
} from "../../stores/terminalStore";
import {
  clearPaneBackendPending,
  disposeSessionBackend,
} from "../../hooks/useTerminal";
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
import { TerminalModuleContextBridge } from "./ai/TerminalModuleContextBridge";
import { buildTerminalModuleContext } from "./ai/types";
import { EMPTY_TERMINAL_BLOCKS, useBlocksStore } from "../../stores/blocksStore";
import { clearTerminalPaneSender } from "./terminalPaneSenders";
import {
  bootstrapTerminalHistory,
  startTerminalHistorySync,
} from "./terminalHistorySync";
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
import { TerminalSessionsWorkspaceView } from "./TerminalSessionsWorkspaceView";
import { useTerminalSessionsChrome } from "./TerminalSessionsChromeContext";
import {
  clearTerminalBackendSessionTouch,
  startTerminalBackendLifecycle,
  touchTerminalBackendSession,
} from "./terminalBackendLifecycle";
import { useTerminalHistoryStore } from "../../stores/terminalHistoryStore";

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

function resolveSessionIdFromTabId(tabId: string): string | null {
  const tab = useTerminalStore.getState().tabs.find((item) => item.id === tabId);
  return tab?.sessionId ?? tabId;
}

function TerminalModuleDock({
  moduleDockProps,
}: {
  moduleDockProps: Omit<ComponentProps<typeof ModuleSegmentDock>, "moduleTitle">;
}) {
  const { t } = useI18n();
  const { sidebarCollapsed } = useTerminalSessionsChrome();

  return (
    <ModuleSegmentDock
      {...moduleDockProps}
      moduleTitle={sidebarCollapsed ? t("routes.terminal") : undefined}
    />
  );
}

export function TerminalPanel() {
  const { t } = useI18n();
  const location = useLocation();
  const isActiveRoute = location.pathname === "/module/terminal";
  const allTabs = useTerminalStore((state) => state.tabs);
  const tabs = useMemo(
    () => allTabs.filter((tab) => !tab.workspaceOnly),
    [allTabs],
  );
  const sessions = useTerminalStore((state) => state.sessions);
  const activeTabId = useTerminalStore((state) => state.activeTabId);
  const activeSessionId = useTerminalStore((state) => state.activeSessionId);
  const closeTabOnly = useTerminalStore((state) => state.closeTabOnly);
  const endSession = useTerminalStore((state) => state.endSession);
  const openSessionTab = useTerminalStore((state) => state.openSessionTab);
  const setActiveTab = useTerminalStore((state) => state.setActiveTab);
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

  const activeTerminalTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? null,
    [activeTabId, tabs],
  );
  const activeTerminalResource = useMemo(
    () => resolveResourceById(activeTerminalTab?.session.resourceId ?? null),
    [activeTerminalTab?.session.resourceId],
  );
  const sessionBlocks = useBlocksStore((state) =>
    activeSessionId ? state.blocks[activeSessionId] ?? EMPTY_TERMINAL_BLOCKS : EMPTY_TERMINAL_BLOCKS,
  );
  const terminalAiContext = useMemo(
    () =>
      buildTerminalModuleContext({
        activeSessionId,
        session: activeTerminalTab?.session ?? null,
        resource: activeTerminalResource,
        blocks: sessionBlocks,
      }),
    [activeTerminalResource, activeTerminalTab?.session, activeSessionId, sessionBlocks],
  );

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
  }, [setActiveTab]);

  useEffect(() => {
    const stopSync = startTerminalHistorySync();
    return stopSync;
  }, []);

  useEffect(() => {
    const stopLifecycle = startTerminalBackendLifecycle();
    return stopLifecycle;
  }, []);

  useEffect(() => {
    const sessionIds = sessions
      .filter((session) => session.lifecycle !== "ended")
      .map((session) => session.id);
    if (sessionIds.length === 0) return;
    bootstrapTerminalHistory(sessionIds);
  }, [sessions]);

  useEffect(() => {
    if (!activeSessionId) return;
    useTerminalHistoryStore.getState().restoreSession(activeSessionId);
  }, [activeSessionId]);

  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    tabId: string;
    index: number;
  } | null>(null);

  useEffect(() => {
    if (!isActiveRoute) return;
    if (tabs.length === 0) return;
    if (!activeTabId || !tabs.some((tab) => tab.id === activeTabId)) {
      setActiveTab(tabs[0].id);
    }
  }, [isActiveRoute, tabs, activeTabId, setActiveTab]);

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

  const detachTabView = useCallback((tabId: string) => {
    const sessionId = resolveSessionIdFromTabId(tabId);
    if (!sessionId) return;
    clearTerminalPaneSender(sessionId);
    clearPaneBackendPending(sessionId);
    touchTerminalBackendSession(sessionId);
    closeTabOnly(sessionId);
    setDockLayout(
      removeTabFromTerminalLayout(useTerminalDockLayoutStore.getState().savedLayout, tabId),
    );
  }, [closeTabOnly, setDockLayout]);

  const handleEndSession = useCallback((sessionId: string) => {
    const openTab = useTerminalStore.getState().tabs.find((tab) => tab.sessionId === sessionId);
    clearTerminalPaneSender(sessionId);
    clearPaneBackendPending(sessionId);
    disposeSessionBackend(sessionId);
    clearTerminalBackendSessionTouch(sessionId);
    endSession(sessionId);
    if (openTab) {
      setDockLayout(
        removeTabFromTerminalLayout(useTerminalDockLayoutStore.getState().savedLayout, openTab.id),
      );
    }
  }, [endSession, setDockLayout]);

  useEffect(() => {
    const validIds = new Set(sshHosts.map((host) => host.id));
    const orphans = sessions.filter(
      (session) =>
        session.lifecycle !== "ended" &&
        session.session.type === "remote" &&
        !validIds.has(session.session.resourceId),
    );
    for (const orphan of orphans) {
      handleEndSession(orphan.id);
    }
  }, [handleEndSession, sessions, sshHosts]);

  const handleCloseTabs = useCallback(
    (ids: string[]) => {
      const uniqueIds = [...new Set(ids.filter(Boolean))];
      for (const id of uniqueIds) {
        detachTabView(id);
      }
    },
    [detachTabView],
  );

  const handleCloseTab = useCallback(
    (id: string) => {
      handleCloseTabs([id]);
    },
    [handleCloseTabs],
  );

  const handleSelectSession = useCallback(
    (sessionId: string) => {
      const tabId = openSessionTab(sessionId);
      setActiveTab(tabId);
      useTerminalHistoryStore.getState().restoreSession(sessionId);
    },
    [openSessionTab, setActiveTab],
  );

  const handleCreateSession = useCallback(
    (resourceId: string, title: string) => {
      let tabId: string;
      if (resourceId === LOCAL_TERMINAL_RESOURCE_ID) {
        tabId = addLocalTerminalTab(title);
      } else {
        tabId = addSshTerminalTab(resourceId, title);
      }
      selectResource(resourceId);
      setActiveTab(tabId);
    },
    [addLocalTerminalTab, addSshTerminalTab, selectResource, setActiveTab],
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
    (action: TabContextMenuAction | "endSession") => {
      if (!ctxMenu) return;
      const dockVisibleTabs = useTerminalStore
        .getState()
        .tabs.filter((tab) => !tab.workspaceOnly);
      const idx = dockVisibleTabs.findIndex((tab) => tab.id === ctxMenu.tabId);

      if (action === "rename") {
        setCtxMenu(null);
        return;
      }
      if (action === "endSession") {
        const sessionId = resolveSessionIdFromTabId(ctxMenu.tabId);
        if (sessionId) handleEndSession(sessionId);
        setCtxMenu(null);
        return;
      }
      if (action === "copyToWorkspace") {
        if (!activeWorkspaceId) return;
        const ctxTab = dockVisibleTabs.find((tab) => tab.id === ctxMenu.tabId);
        if (ctxTab) {
          addSnapshotToWorkspace(activeWorkspaceId, copyTerminalTabToWorkspaceSnapshot(ctxTab));
        }
        setCtxMenu(null);
        return;
      }
      if (action === "moveToWorkspace") {
        if (!activeWorkspaceId) return;
        const ctxTab = dockVisibleTabs.find((tab) => tab.id === ctxMenu.tabId);
        if (ctxTab) {
          const currentLayout = useTerminalDockLayoutStore.getState().savedLayout;
          setDockLayout(removeTabFromTerminalLayout(currentLayout, ctxTab.id));
          useTerminalStore.getState().setTabWorkspaceOnly(ctxTab.id, true);
          const visibleAfter = useTerminalStore
            .getState()
            .tabs.filter((tab) => !tab.workspaceOnly);
          const activeId = useTerminalStore.getState().activeTabId;
          if (!activeId || !visibleAfter.some((tab) => tab.id === activeId)) {
            setActiveTab(visibleAfter[0]?.id ?? "");
          }
          addSnapshotToWorkspace(activeWorkspaceId, moveTerminalTabToWorkspaceSnapshot(ctxTab));
        }
        setCtxMenu(null);
        return;
      }
      if (action === "close") {
        handleCloseTab(ctxMenu.tabId);
      } else if (action === "closeLeft") {
        if (idx > 0) {
          handleCloseTabs(dockVisibleTabs.slice(0, idx).map((tab) => tab.id));
        }
      } else if (action === "closeRight") {
        if (idx >= 0 && idx < dockVisibleTabs.length - 1) {
          handleCloseTabs(dockVisibleTabs.slice(idx + 1).map((tab) => tab.id));
        }
      } else if (action === "closeOthers") {
        if (idx >= 0) {
          handleCloseTabs(
            dockVisibleTabs.filter((tab) => tab.id !== ctxMenu.tabId).map((tab) => tab.id),
          );
        }
      } else if (action === "closeAll") {
        handleCloseTabs(dockVisibleTabs.map((tab) => tab.id));
      }
      setCtxMenu(null);
    },
    [ctxMenu, handleCloseTab, handleCloseTabs, handleEndSession, activeWorkspaceId, setActiveTab, setDockLayout],
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
      <TerminalModuleContextBridge active={isActiveRoute} context={terminalAiContext} />
      <TerminalSessionsWorkspaceView
        onSelectSession={handleSelectSession}
        onCreateSession={handleCreateSession}
        onEndSession={handleEndSession}
      >
        <TerminalModuleDock
          moduleDockProps={{
            className: "terminal-module-dock",
            dockScope: "terminal",
            acceptExternalDrops: true,
            tabs: dockTabs,
            activeTabId: activeTabId ?? visibleTabs[0]?.id ?? "",
            onActiveTabChange: setActiveTab,
            onCloseTab: handleCloseTab,
            savedLayout: visibleTabs.length === 0 ? null : dockLayout,
            onSavedLayoutChange: setDockLayout,
            renderPanel: renderDockPanel,
            onTabContextMenu: handleDockTabContextMenu,
            addTabConfig,
            enabled: isActiveRoute,
            emptyContent: (
              <div className="term-workspace__empty">
                <p className="term-workspace__empty-title">{t("terminal.sessions.workspaceEmpty")}</p>
                <p className="term-workspace__empty-hint">{t("terminal.sessions.workspaceEmptyHint")}</p>
              </div>
            ),
          }}
        />
      </TerminalSessionsWorkspaceView>
      {ctxMenu && (() => {
        const menuTabIndex = visibleTabs.findIndex((tab) => tab.id === ctxMenu.tabId);
        const closeItems = buildTabCloseMenuItems(
          t,
          visibleTabs.length,
          menuTabIndex >= 0 ? menuTabIndex : 0,
          handleContextAction,
          { showWorkspaceActions: true },
        );
        const endSessionItem = {
          id: "tab-end-session",
          label: t("terminal.sessions.end"),
          onClick: () => handleContextAction("endSession"),
        };
        const items = [
          endSessionItem,
          { id: "tab-sep-end", separator: true, label: "" },
          ...closeItems,
        ];
        return (
          <ContextMenu
            items={items}
            position={{ x: ctxMenu.x, y: ctxMenu.y }}
            onClose={() => setCtxMenu(null)}
          />
        );
      })()}
    </>
  );
}
