import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, startTransition, type ComponentProps, type MouseEvent as ReactMouseEvent } from "react";
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
import { useBottomPanelStore } from "../../stores/bottomPanelStore";
import { useI18n } from "../../i18n";
import { showToast } from "../../stores/toastStore";
import type { TopbarTabDef } from "../../stores/topbarStore";
import { LOCAL_TERMINAL_RESOURCE_ID } from "./paneResource";
import { TerminalTabDockPane } from "./TerminalTabDockPane";
import { TerminalModuleContextBridge } from "./ai/TerminalModuleContextBridge";
import { buildTerminalModuleContext } from "./ai/types";
import { EMPTY_TERMINAL_BLOCKS, useBlocksStore } from "../../stores/blocksStore";
import { clearTerminalPaneSender } from "./terminalPaneSenders";
import { cancelAutoReconnectSsh } from "./autoReconnectTerminalSsh";
import {
  bootstrapTerminalHistory,
} from "./terminalHistorySync";
import {
  moveTerminalTabToWorkspaceSnapshot,
} from "../../lib/workspaceTabActions";
import { deliverSnapshotToWorkspace } from "../../lib/workspaceSnapshotDelivery";
import { subscribeDockviewTransfer } from "../../lib/dockviewRegistry";
import { restoreTerminalTabFromWorkspaceTransfer } from "../../lib/moduleToWorkspaceTransfer";
import { ModuleSegmentDock } from "../../components/dock";
import {
  removeTabFromTerminalLayout,
  useTerminalDockLayoutStore,
} from "../../stores/terminalDockLayoutStore";
import { ContextMenu } from "../../components/ui/menu/ContextMenu";
import { QuickInputDialog } from "../../components/ui/form/QuickInputDialog";
import {
  buildWorkspaceTabMenuItems,
  buildTabBulkCloseSubmenuItems,
  type TabContextMenuAction,
} from "../../components/ui/menu/contextMenuItems";
import type { ContextMenuItem } from "../../components/ui/menu/ContextMenu";
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
import { renameSessionWithAi } from "./sessionAutoName";
import { formatTerminalTabLabel } from "./terminalSessionDisplay";

function tabLabel(tab: TerminalTab, fallbackName?: string) {
  return formatTerminalTabLabel(
    tab.session.resourceId,
    tab.title,
    fallbackName,
    tab.session.shellLabel,
  );
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

/** 模块 dock 中会话 tab 离开后，优先激活紧邻左侧（跳过即将隐藏的 tab） */
function resolveNextVisibleSessionTabId(removedTabId: string): string {
  const visible = useTerminalStore
    .getState()
    .tabs.filter((tab) => !tab.workspaceOnly && tab.id !== removedTabId);
  const before = useTerminalStore
    .getState()
    .tabs.filter((tab) => !tab.workspaceOnly);
  const index = before.findIndex((tab) => tab.id === removedTabId);
  if (index < 0) return visible[0]?.id ?? "";
  return before[index - 1]?.id ?? before[index + 1]?.id ?? "";
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
  /** 关闭/拖出会话 tab 期间忽略 dockview 误激活 SSH 管理页 */
  const suppressSshDockActivationRef = useRef(false);
  const suppressSshDockActivationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const beginSuppressSshDockActivation = useCallback(() => {
    suppressSshDockActivationRef.current = true;
    if (suppressSshDockActivationTimerRef.current) {
      clearTimeout(suppressSshDockActivationTimerRef.current);
    }
    // 跨 dock 拖出时 removePanel 会再延迟两个 rAF，抑制窗口须覆盖到那之后
    suppressSshDockActivationTimerRef.current = setTimeout(() => {
      suppressSshDockActivationRef.current = false;
      suppressSshDockActivationTimerRef.current = null;
    }, 120);
  }, []);

  useEffect(
    () => () => {
      if (suppressSshDockActivationTimerRef.current) {
        clearTimeout(suppressSshDockActivationTimerRef.current);
      }
    },
    [],
  );
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
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const taskbarSubWindowTabId = useBottomPanelStore((s) => s.taskbarSubWindowTabId);

  const activeTerminalTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? null,
    [activeTabId, tabs],
  );
  const activeTerminalResource = useMemo(
    () => resolveResourceById(activeTerminalTab?.session.resourceId ?? null),
    [activeTerminalTab?.session.resourceId],
  );
  const terminalAiContext = useMemo(() => {
    const blocks =
      activeSessionId
        ? useBlocksStore.getState().blocks[activeSessionId] ?? EMPTY_TERMINAL_BLOCKS
        : EMPTY_TERMINAL_BLOCKS;
    return buildTerminalModuleContext({
      activeSessionId,
      session: activeTerminalTab?.session ?? null,
      resource: activeTerminalResource,
      blocks,
    });
  }, [activeTerminalResource, activeTerminalTab?.session, activeSessionId]);

  useEffect(() => {
    return subscribeDockviewTransfer((meta) => {
      if (!meta.newPanelId.startsWith("terminal:")) return;
      if (!meta.originScope.startsWith("workspace-bottom-")) return;
      if (restoreTerminalTabFromWorkspaceTransfer(meta)) return;
      // 兜底：旧版镜像 tab
      const prefix = `${meta.originScope}:`;
      const originTerminalId = meta.originPanelId.startsWith(prefix)
        ? meta.originPanelId.slice(prefix.length)
        : meta.originPanelId;
      setActiveTab(originTerminalId);
      window.dispatchEvent(
        new CustomEvent("omnipanel-terminal-focus-tab", { detail: { tabId: originTerminalId } }),
      );
    });
  }, [setActiveTab]);

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
      startTransition(() => {
        selectResource(activeTab.session.resourceId);
      });
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

    beginSuppressSshDockActivation();
    clearTerminalPaneSender(sessionId);
    clearPaneBackendPending(sessionId);
    touchTerminalBackendSession(sessionId);
    closeTabOnly(sessionId);

    const nextActive = useTerminalStore.getState().activeTabId;
    if (nextActive) {
      setActiveTab(nextActive);
      setDockActiveId(nextActive);
      focusSessionsPanel();
    } else {
      setDockActiveId("");
    }

    setDockLayout(
      removeTabFromTerminalLayout(
        useTerminalDockLayoutStore.getState().savedLayout,
        tabId,
        nextActive ?? undefined,
      ),
    );
  }, [beginSuppressSshDockActivation, closeTabOnly, focusSessionsPanel, setActiveTab, setDockLayout]);

  const handleEndSession = useCallback((sessionId: string) => {
    const openTab = useTerminalStore.getState().tabs.find((tab) => tab.sessionId === sessionId);
    beginSuppressSshDockActivation();
    clearTerminalPaneSender(sessionId);
    clearPaneBackendPending(sessionId);
    disposeSessionBackend(sessionId);
    clearTerminalBackendSessionTouch(sessionId);
    endSession(sessionId);

    const nextActive = useTerminalStore.getState().activeTabId;
    if (nextActive) {
      setActiveTab(nextActive);
      setDockActiveId(nextActive);
      focusSessionsPanel();
    } else {
      setDockActiveId("");
    }

    if (openTab) {
      setDockLayout(
        removeTabFromTerminalLayout(
          useTerminalDockLayoutStore.getState().savedLayout,
          openTab.id,
          nextActive ?? undefined,
        ),
      );
    }
  }, [beginSuppressSshDockActivation, endSession, focusSessionsPanel, setActiveTab, setDockLayout]);

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
        const sessionId = resolveSessionIdFromTabId(id);
        if (sessionId) cancelAutoReconnectSsh(sessionId);
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
      // 与 handleTopbarAdd 保持一致：先激活 tab，再切换面板
      setActiveTab(tabId);
      setDockActiveId(tabId);
      focusSessionsPanel();
      selectResource(resourceId);
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

  useEffect(() => {
    const handler = (event: Event) => {
      const tabId = (event as CustomEvent<{ tabId?: string }>).detail?.tabId;
      if (!tabId) return;
      focusSessionsPanel();
      setDockActiveId(tabId);
      setActiveTab(tabId);
    };
    window.addEventListener("omnipanel-terminal-focus-tab", handler);
    return () => window.removeEventListener("omnipanel-terminal-focus-tab", handler);
  }, [focusSessionsPanel, setActiveTab]);

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
        // 关闭/拖出会话 tab 时 dockview 常会落到最左的 SSH 管理页，忽略这次误激活
        if (suppressSshDockActivationRef.current) return;
        focusSshPanel();
        setDockActiveId(tabId);
        return;
      }
      focusSessionsPanel();
      setDockActiveId(tabId);
      startTransition(() => {
        setActiveTab(tabId);
      });
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

  const handleEndSessionsForTabs = useCallback(
    (ids: string[]) => {
      const sessionIds = new Set<string>();
      for (const id of ids) {
        const sessionId = resolveSessionIdFromTabId(id);
        if (sessionId) sessionIds.add(sessionId);
      }
      for (const sessionId of sessionIds) {
        cancelAutoReconnectSsh(sessionId);
        handleEndSession(sessionId);
      }
    },
    [handleEndSession],
  );

  const handleCopyTab = useCallback(
    (tabId: string) => {
      const ctxTab = useTerminalStore.getState().tabs.find((tab) => tab.id === tabId);
      if (!ctxTab) return;
      const copyTitle = `${ctxTab.title} (副本)`;
      const newSessionId = `sess-copy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const store = useTerminalStore.getState();
      store.createSession(copyTitle, ctxTab.session, newSessionId);
      const newTabId = store.openSessionTab(newSessionId);
      if (newTabId) setActiveTab(newTabId);
    },
    [setActiveTab],
  );

  const reconnectSession = useCallback((sessionId: string) => {
    clearTerminalPaneSender(sessionId);
    clearPaneBackendPending(sessionId);
    disposeSessionBackend(sessionId);
    cancelAutoReconnectSsh(sessionId);
    useTerminalStore.getState().setBackendSessionId(sessionId, null);
    useTerminalStore.getState().setStatus(sessionId, "connecting");
    useTerminalStore.getState().bumpReconnect(sessionId);
  }, []);

  const performMoveTabToWorkspace = useCallback(
    (tabId: string, targetWorkspaceId: string) => {
      if (!targetWorkspaceId) return;
      const ctxTab = useTerminalStore.getState().tabs.find((tab) => tab.id === tabId);
      if (!ctxTab || ctxTab.workspaceOnly) return;

      beginSuppressSshDockActivation();
      const prevActive = useTerminalStore.getState().activeTabId;
      const nextActive = resolveNextVisibleSessionTabId(ctxTab.id);

      const currentLayout = useTerminalDockLayoutStore.getState().savedLayout;
      setDockLayout(removeTabFromTerminalLayout(currentLayout, ctxTab.id, nextActive || undefined));
      useTerminalStore.getState().setTabWorkspaceOnly(ctxTab.id, true);

      const visibleAfter = useTerminalStore
        .getState()
        .tabs.filter((tab) => !tab.workspaceOnly);
      if (prevActive === ctxTab.id || !visibleAfter.some((tab) => tab.id === prevActive)) {
        if (nextActive) {
          setActiveTab(nextActive);
          setDockActiveId(nextActive);
        } else {
          setDockActiveId("");
        }
      } else if (prevActive) {
        setDockActiveId(prevActive);
      }
      focusSessionsPanel();

      void deliverSnapshotToWorkspace(
        targetWorkspaceId,
        moveTerminalTabToWorkspaceSnapshot(ctxTab),
        { backendSessionId: ctxTab.backendSessionId },
      );
      setCtxMenu(null);
    },
    [beginSuppressSshDockActivation, focusSessionsPanel, setActiveTab, setDockLayout],
  );

  const handleContextAction = useCallback(
    (action: TabContextMenuAction | "closeAndEnd" | "copy") => {
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
          });
        }
        setCtxMenu(null);
        return;
      }
      if (action === "aiRename") {
        const sessionId = resolveSessionIdFromTabId(ctxMenu.tabId);
        if (sessionId) {
          void renameSessionWithAi(sessionId).then((result) => {
            if (!result.ok) {
              if (result.reason === "no-provider") {
                showToast(t("terminal.sessions.aiRenameNoProvider"));
              } else if (result.reason === "no-context") {
                showToast(t("terminal.sessions.aiRenameNoContext"));
              } else {
                showToast(t("terminal.sessions.aiRenameFailed"));
              }
            }
          });
        }
        setCtxMenu(null);
        return;
      }
      if (action === "copy") {
        handleCopyTab(ctxMenu.tabId);
        setCtxMenu(null);
        return;
      }
      if (action === "closeAndEnd") {
        const sessionId = resolveSessionIdFromTabId(ctxMenu.tabId);
        if (sessionId) {
          cancelAutoReconnectSsh(sessionId);
          handleEndSession(sessionId);
        }
        setCtxMenu(null);
        return;
      }
      if (action === "closeLeft") {
        if (idx > 0) {
          handleEndSessionsForTabs(dockVisibleTabs.slice(0, idx).map((tab) => tab.id));
        }
      } else if (action === "closeRight") {
        if (idx >= 0 && idx < dockVisibleTabs.length - 1) {
          handleEndSessionsForTabs(dockVisibleTabs.slice(idx + 1).map((tab) => tab.id));
        }
      } else if (action === "closeOthers") {
        if (idx >= 0) {
          handleEndSessionsForTabs(
            dockVisibleTabs.filter((tab) => tab.id !== ctxMenu.tabId).map((tab) => tab.id),
          );
        }
      } else if (action === "closeAll") {
        handleEndSessionsForTabs(dockVisibleTabs.map((tab) => tab.id));
      }
      setCtxMenu(null);
    },
    [ctxMenu, handleCopyTab, handleEndSession, handleEndSessionsForTabs, t],
  );

  const handleConfirmRename = useCallback(
    (trimmed: string) => {
      if (!renameTarget) return;
      if (trimmed !== renameTarget.currentTitle) {
        useTerminalStore.getState().renameTab(renameTarget.tabId, trimmed);
      }
      setRenameTarget(null);
    },
    [renameTarget],
  );

  const handlePanelTransferredOut = useCallback(
    (panelId: string, targetScope: string) => {
      if (!targetScope.startsWith("workspace-bottom-")) return;
      if (isTerminalSshManagementTab(panelId)) return;
      const ctxTab = useTerminalStore.getState().tabs.find((tab) => tab.id === panelId);
      if (!ctxTab) return;

      beginSuppressSshDockActivation();
      const prevActive = useTerminalStore.getState().activeTabId;
      const nextActive = resolveNextVisibleSessionTabId(panelId);

      setDockLayout(
        removeTabFromTerminalLayout(
          useTerminalDockLayoutStore.getState().savedLayout,
          panelId,
          nextActive || undefined,
        ),
      );
      useTerminalStore.getState().setTabWorkspaceOnly(panelId, true);

      const visibleAfter = useTerminalStore
        .getState()
        .tabs.filter((tab) => !tab.workspaceOnly);
      if (prevActive === panelId || !visibleAfter.some((tab) => tab.id === prevActive)) {
        if (nextActive) {
          setActiveTab(nextActive);
          setDockActiveId(nextActive);
        } else {
          setDockActiveId("");
        }
      } else if (prevActive) {
        setDockActiveId(prevActive);
      }
      // 拖出后 dockview 常会落到 SSH 管理页，强制留在会话侧
      focusSessionsPanel();
    },
    [beginSuppressSshDockActivation, focusSessionsPanel, setActiveTab, setDockLayout],
  );

  const renderDockPanel = useCallback(
    (tabId: string) => {
      if (isTerminalSshManagementTab(tabId)) {
        return <SshWorkspacePanel embedded />;
      }
      return (
        <TerminalTabDockPane
          tabId={tabId}
          isActive={
            tabId === effectiveDockActiveId && tabId !== taskbarSubWindowTabId
          }
        />
      );
    },
    [effectiveDockActiveId, taskbarSubWindowTabId],
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
            // xterm / 嵌套侧栏需常驻；切 Tab 的 isActive 由 DockableWorkspace 局部 soft bump
            defaultRenderer: "always" as const,
            softRefreshKey: taskbarSubWindowTabId
              ? `taskbar:${taskbarSubWindowTabId}`
              : undefined,
            onActiveTabChange: handleDockActiveChange,
            onCloseTab: handleCloseTab,
            savedLayout: visibleTabs.length === 0 ? null : dockLayout,
            onSavedLayoutChange: setDockLayout,
            renderPanel: renderDockPanel,
            panelContentKeysByTab: {
              [TERMINAL_SSH_MANAGEMENT_TAB_ID]: sshDockPanelContentKey,
            },
            onTabContextMenu: handleDockTabContextMenu,
            onPanelTransferredOut: handlePanelTransferredOut,
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
        const tabCount = visibleTabs.length;
        const tabIndex = menuTabIndex >= 0 ? menuTabIndex : 0;
        const items: ContextMenuItem[] = [
          {
            id: "tab-reconnect",
            label: t("terminal.reconnect.menu"),
            icon: (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 12a9 9 0 0115.5-6.36L21 8" />
                <path d="M21 3v5h-5" />
                <path d="M21 12a9 9 0 01-15.5 6.36L3 16" />
                <path d="M3 21v-5h5" />
              </svg>
            ),
            onClick: () => {
              const sessionId = resolveSessionIdFromTabId(ctxMenu.tabId);
              if (sessionId) reconnectSession(sessionId);
              setCtxMenu(null);
            },
          },
          { id: "tab-sep-reconnect", separator: true, label: "" },
          {
            id: "tab-rename",
            label: t("shell.topbar.rename"),
            onClick: () => handleContextAction("rename"),
          },
          {
            id: "tab-ai-rename",
            label: t("terminal.sessions.aiRename"),
            onClick: () => handleContextAction("aiRename"),
          },
          { id: "tab-sep-rename", separator: true, label: "" },
          {
            id: "tab-copy",
            label: t("terminal.sessions.copy"),
            onClick: () => handleContextAction("copy"),
          },
          { id: "tab-sep-copy", separator: true, label: "" },
          ...buildWorkspaceTabMenuItems(t, {
            showWorkspaceActions: true,
            currentWorkspaceId: activeWorkspaceId,
            workspaces,
            onMoveToWorkspace: (workspaceId) =>
              performMoveTabToWorkspace(ctxMenu.tabId, workspaceId),
          }),
          {
            id: "tab-close-and-end",
            label: t("shell.topbar.close"),
            onClick: () => handleContextAction("closeAndEnd"),
          },
          {
            id: "tab-close-bulk",
            label: t("shell.topbar.closeTabs"),
            children: buildTabBulkCloseSubmenuItems(t, tabCount, tabIndex, handleContextAction),
          },
        ];
        return (
          <ContextMenu
            items={items}
            position={{ x: ctxMenu.x, y: ctxMenu.y }}
            onClose={() => setCtxMenu(null)}
          />
        );
      })()}
      <QuickInputDialog
        open={renameTarget != null}
        title={t("shell.topbar.rename")}
        subtitle={renameTarget?.currentTitle}
        defaultValue={renameTarget?.currentTitle ?? ""}
        onCancel={() => setRenameTarget(null)}
        onConfirm={handleConfirmRename}
      />
    </>
  );
}
