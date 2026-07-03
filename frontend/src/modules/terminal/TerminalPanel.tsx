import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type MouseEvent as ReactMouseEvent } from "react";
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
import { SshWorkspacePanel } from "../server/ssh/SshWorkspacePanel";
import { useTerminalLeftPanelStore } from "./terminalLeftPanelStore";
import { useSshActiveHostStore } from "../server/ssh/stores/sshActiveHostStore";
import {
  TERMINAL_SSH_MANAGEMENT_TAB_ID,
  isTerminalSshManagementTab,
} from "./constants";
import { useSshWorkspaceNavStore } from "../server/ssh/stores/sshWorkspaceNavStore";
import { TerminalFilePreviewSubWindow } from "./TerminalFilePreviewSubWindow";

function tabLabel(tab: TerminalTab, fallbackName?: string) {
  // 用户重命名 (tab.title) 优先于资源名 —— 用户能区分同一资源下的多个 tab
  return tab.title || fallbackName || resolveResourceById(tab.session.resourceId)?.name || tab.session.resourceId;
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
  const leftPanelMode = useTerminalLeftPanelStore((s) => s.mode);
  const focusSshPanel = useTerminalLeftPanelStore((s) => s.focusSsh);
  const focusSessionsPanel = useTerminalLeftPanelStore((s) => s.focusSessions);
  const isSshMode = leftPanelMode === "ssh";
  const sshSection = useSshWorkspaceNavStore((s) => s.section);
  const [dockActiveId, setDockActiveId] = useState("");
  const sshModePrevRef = useRef(isSshMode);
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
  const sshActiveHostId = useSshActiveHostStore((s) => s.activeHostId);

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
  // Tab 重命名 prompt：null 表示关闭，否则 { tabId, currentTitle }
  const [renameTarget, setRenameTarget] = useState<{
    tabId: string;
    currentTitle: string;
    value: string;
  } | null>(null);

  useEffect(() => {
    if (!isActiveRoute) return;
    if (isSshMode && isTerminalSshManagementTab(dockActiveId)) return;
    if (tabs.length === 0) return;
    if (!activeTabId || !tabs.some((tab) => tab.id === activeTabId)) {
      setActiveTab(tabs[0].id);
    }
  }, [isActiveRoute, tabs, activeTabId, setActiveTab, isSshMode, dockActiveId]);

  useLayoutEffect(() => {
    const enteredSsh = isSshMode && !sshModePrevRef.current;
    const leftSsh = !isSshMode && sshModePrevRef.current;
    sshModePrevRef.current = isSshMode;

    if (enteredSsh) {
      setDockActiveId(TERMINAL_SSH_MANAGEMENT_TAB_ID);
      return;
    }
    if (leftSsh) {
      setDockActiveId((current) => {
        if (!isTerminalSshManagementTab(current)) return current;
        const state = useTerminalStore.getState();
        const next =
          state.activeTabId && !isTerminalSshManagementTab(state.activeTabId)
            ? state.activeTabId
            : state.tabs.find((tab) => !tab.workspaceOnly)?.id ?? "";
        return next || current;
      });
    }
  }, [isSshMode]);

  useLayoutEffect(() => {
    if (!isSshMode) return;
    if (sshSection === "hosts") return;
    setDockActiveId(TERMINAL_SSH_MANAGEMENT_TAB_ID);
  }, [sshSection, isSshMode]);

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
      if (isTerminalSshManagementTab(id)) return;
      handleCloseTabs([id]);
    },
    [handleCloseTabs],
  );

  const handleSelectSession = useCallback(
    (sessionId: string) => {
      const tabId = openSessionTab(sessionId);
      focusSessionsPanel();
      setDockActiveId(tabId);
      setActiveTab(tabId);
      useTerminalHistoryStore.getState().restoreSession(sessionId);
    },
    [focusSessionsPanel, openSessionTab, setActiveTab],
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
      focusSessionsPanel();
      setDockActiveId(tabId);
      setActiveTab(tabId);
    },
    [addLocalTerminalTab, addSshTerminalTab, focusSessionsPanel, selectResource, setActiveTab],
  );

  const visibleTabs = useMemo(
    () =>
      tabs.filter(
        (tab) => !tab.workspaceOnly,
      ),
    [tabs],
  );

  useLayoutEffect(() => {
    if (isSshMode) return;
    if (!isTerminalSshManagementTab(dockActiveId)) return;
    const next =
      activeTabId && !isTerminalSshManagementTab(activeTabId)
        ? activeTabId
        : visibleTabs[0]?.id ?? "";
    if (next) setDockActiveId(next);
  }, [activeTabId, dockActiveId, isSshMode, visibleTabs]);

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

  const mergedDockTabs = useMemo(
    () => [
      {
        id: TERMINAL_SSH_MANAGEMENT_TAB_ID,
        label: t("terminal.leftPanel.ssh"),
        panelType: "ssh-management",
        closable: false,
      },
      ...dockTabs,
    ],
    [dockTabs, t],
  );

  const effectiveDockActiveId = useMemo(() => {
    const isValidTab = (id: string) =>
      mergedDockTabs.some((tab) => tab.id === id);

    if (isSshMode) {
      if (
        dockActiveId &&
        !isTerminalSshManagementTab(dockActiveId) &&
        isValidTab(dockActiveId)
      ) {
        return dockActiveId;
      }
      return TERMINAL_SSH_MANAGEMENT_TAB_ID;
    }

    if (
      activeTabId &&
      !isTerminalSshManagementTab(activeTabId) &&
      isValidTab(activeTabId)
    ) {
      return activeTabId;
    }
    if (
      dockActiveId &&
      !isTerminalSshManagementTab(dockActiveId) &&
      isValidTab(dockActiveId)
    ) {
      return dockActiveId;
    }
    return visibleTabs[0]?.id ?? "";
  }, [activeTabId, dockActiveId, isSshMode, mergedDockTabs, visibleTabs]);

  const handleDockActiveChange = useCallback(
    (tabId: string) => {
      if (isTerminalSshManagementTab(tabId)) {
        focusSshPanel();
        setDockActiveId(tabId);
        return;
      }
      focusSessionsPanel();
      setDockActiveId(tabId);
      setActiveTab(tabId);
    },
    [focusSessionsPanel, focusSshPanel, setActiveTab],
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
    focusSessionsPanel();
    setDockActiveId(id);
    setActiveTab(id);
  }, [addLocalTerminalTab, focusSessionsPanel, setActiveTab, workspaceActiveResource?.name, t]);

  const handleTopbarAddMenuSelect = useCallback(
    (id: string) => {
      if (id === "manage-hosts") {
        focusSshPanel();
        setDockActiveId(TERMINAL_SSH_MANAGEMENT_TAB_ID);
        return;
      }
      if (id === LOCAL_TERMINAL_RESOURCE_ID) {
        const tabId = addLocalTerminalTab(t("terminal.newSession.local"));
        selectResource(LOCAL_TERMINAL_RESOURCE_ID);
        focusSessionsPanel();
        setDockActiveId(tabId);
        setActiveTab(tabId);
        return;
      }
      const host = sshHosts.find((item) => item.id === id);
      if (host) {
        const tabId = addSshTerminalTab(host.id, host.name);
        selectResource(host.id);
        focusSessionsPanel();
        setDockActiveId(tabId);
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
      focusSshPanel,
      focusSessionsPanel,
    ],
  );

  const handleDockTabContextMenu = useCallback(
    (event: ReactMouseEvent, tabId: string, index: number) => {
      if (isTerminalSshManagementTab(tabId)) return;
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
        const ctxTab = dockVisibleTabs.find((tab) => tab.id === ctxMenu.tabId);
        if (ctxTab) {
          setRenameTarget({
            tabId: ctxTab.id,
            currentTitle: ctxTab.title,
            value: ctxTab.title,
          });
        }
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

  const commitRename = useCallback(() => {
    if (!renameTarget) return;
    const trimmed = renameTarget.value.trim();
    if (!trimmed) {
      setRenameTarget(null);
      return;
    }
    if (trimmed !== renameTarget.currentTitle) {
      useTerminalStore.getState().renameTab(renameTarget.tabId, trimmed);
    }
    setRenameTarget(null);
  }, [renameTarget]);

  const renderDockPanel = useCallback(
    (tabId: string) => {
      if (isTerminalSshManagementTab(tabId)) {
        return <SshWorkspacePanel embedded />;
      }
      return (
        <TerminalTabDockPane
          tabId={tabId}
          isActive={tabId === effectiveDockActiveId}
          onActivate={() => handleDockActiveChange(tabId)}
        />
      );
    },
    [effectiveDockActiveId, handleDockActiveChange],
  );

  const sshDockPanelContentKey = useMemo(
    () => `${isSshMode}:${sshActiveHostId ?? ""}`,
    [isSshMode, sshActiveHostId],
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
            tabs: mergedDockTabs,
            activeTabId: effectiveDockActiveId,
            onActiveTabChange: handleDockActiveChange,
            onCloseTab: handleCloseTab,
            savedLayout: visibleTabs.length === 0 ? null : dockLayout,
            onSavedLayoutChange: setDockLayout,
            renderPanel: renderDockPanel,
            panelContentKeysByTab: {
              [TERMINAL_SSH_MANAGEMENT_TAB_ID]: sshDockPanelContentKey,
            },
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
      {/* 全局单例：所有终端 tab 共享一个文件预览弹窗（zustand store 驱动） */}
      <TerminalFilePreviewSubWindow />
      {ctxMenu && (() => {
        const menuTabIndex = visibleTabs.findIndex((tab) => tab.id === ctxMenu.tabId);
        const closeItems = buildTabCloseMenuItems(
          t,
          visibleTabs.length,
          menuTabIndex >= 0 ? menuTabIndex : 0,
          handleContextAction,
          { showWorkspaceActions: true, showRename: true },
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
      {renameTarget && (
        <RenamePromptDialog
          label={t("shell.topbar.rename")}
          currentTitle={renameTarget.currentTitle}
          value={renameTarget.value}
          onChange={(next) => setRenameTarget({ ...renameTarget, value: next })}
          onCommit={commitRename}
          onCancel={() => setRenameTarget(null)}
        />
      )}
    </>
  );
}

/** 重命名 prompt：极简居中弹窗（terminal 上下文避免 inline bar 干扰） */
function RenamePromptDialog({
  label,
  currentTitle,
  value,
  onChange,
  onCommit,
  onCancel,
}: {
  label: string;
  currentTitle: string;
  value: string;
  onChange: (next: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel]);
  return (
    <div
      className="rename-prompt-backdrop"
      onClick={onCancel}
      role="dialog"
      aria-label={label}
    >
      <div
        className="rename-prompt-dialog"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onCommit();
          }
        }}
      >
        <div className="rename-prompt-label">{label}</div>
        <div className="rename-prompt-current">{currentTitle}</div>
        <input
          type="text"
          className="rename-prompt-input"
          value={value}
          autoFocus
          onChange={(e) => onChange(e.target.value)}
        />
        <div className="rename-prompt-actions">
          <button type="button" className="rename-prompt-btn" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="rename-prompt-btn rename-prompt-btn--primary"
            onClick={onCommit}
          >
            确定
          </button>
        </div>
      </div>
    </div>
  );
}
