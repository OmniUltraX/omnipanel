import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  useLocation,
  useNavigate,
} from "react-router-dom";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  startTransition,
} from "react";
import { Sidebar } from "./components/shell/Sidebar";
import { Topbar } from "./components/shell/Topbar";
import { StatusBar } from "./components/shell/StatusBar";
import { CommandPalette } from "./components/shell/CommandPalette";
import { RecentItemsPanel } from "./components/shell/RecentItemsPanel";
import { NotificationDrawer } from "./components/shell/NotificationDrawer";
import { AiDrawer } from "./components/ai/AiDrawer";
import { AiDockView } from "./components/ai/AiDockView";
import { AiRuntimeProvider } from "./components/ai/assistant-ui/AiRuntimeProvider";
import { DangerConfirmDialog } from "./components/terminal/DangerConfirmDialog";
import { AppDialogHost } from "./components/ui/overlay/AppDialogHost";
import { CloseBehaviorDialogHost } from "./components/ui/overlay/CloseBehaviorDialogHost";
import { QuickInputHost } from "./components/ui/form/QuickInputHost";
import { ToastHost } from "./components/ui/feedback/ToastHost";
import { SkillEvolutionPrompt } from "./components/feedback/SkillEvolutionPrompt";
import { Button } from "./components/ui/primitives/Button";
import { SuspendedModulePanel, OverlayModuleRoutePanel } from "./components/ui/feedback";
import { WorkspaceHost } from "./components/workspace/WorkspaceHost";
import { useBottomPanelStore } from "./stores/bottomPanelStore";
import { workspaceShellState } from "./lib/workspaceMode";
import { useWorkspaceBottomDockStore } from "./stores/workspaceBottomDockStore";
import {
  createInitialOverlayMounted,
  isOverlayModuleKey,
  isOverlayModulePath,
  isShellRoutePath,
} from "./lib/routePanels";
import {
  scheduleIdleTerminalWarm,
  scheduleIdleDatabaseWarm,
  subscribeModuleShellWarm,
} from "./lib/moduleWarmup";
import { WindowResize } from "./components/shell/WindowResize";
import { SettingsWindow } from "./components/settings/SettingsWindow";
import { UserCenterWindow } from "./components/user/UserCenterWindow";
import { AuthProfileSync } from "./components/user/AuthProfileSync";
import { SubWindowMinimizedStack } from "./components/ui/window/SubWindowMinimizedStack";
import { ResourceProfileSubWindow } from "./lib/resource/ResourceProfileSubWindow";
import { useSettingsShortcut } from "./hooks/useSettingsShortcut";
import { useSettingsUiStore } from "./stores/settingsUiStore";
import { useAiStore } from "./stores/aiStore";
import { useAiDrawerShortcut } from "./hooks/useAiDrawerShortcut";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts";
import { useBottomWorkspaceShortcut } from "./hooks/useBottomWorkspaceShortcut";
import { useWorkspaceStore } from "./stores/workspaceStore";
import { useWorkspaceWindowStore } from "./stores/workspaceWindowStore";
import { initMainWindowWorkspaceSync } from "./lib/workspaceWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauriRuntime } from "./lib/isTauriRuntime";
import { ensureSystemTray } from "./lib/systemTray";
import { handleWindowCloseRequested } from "./lib/windowCloseBehavior";
import { useCrossWindowDragInit } from "./lib/useCrossWindowDragInit";
import { initWorkspaceAddSnapshotListener } from "./lib/workspaceSnapshotDelivery";
import { initTabStateTransferListener } from "./lib/tabStateTransfer";
import { CrossWindowDragVisualLayer } from "./components/shell/CrossWindowDragVisualLayer";
import { subscribePersistStoreCrossWindow } from "./lib/crossWindowPersist";
import { isCrossWindowDragRuntime } from "./lib/crossWindowDragEnabled";
import { goWorkspaceHome, navigateToFeature } from "./lib/workspaceNavigation";
import { syncEmbeddedWorkspacePanelVisibility } from "./lib/workspaceTabActions";
import "./lib/workspaceComponentRegistry";
import { useActionStore, getPendingRiskAction } from "./stores/actionStore";
import { useTopbarStore } from "./stores/topbarStore";
import type { DangerCheckResult } from "./lib/commandGuard";
import { getRouteTitle, useI18n } from "./i18n";
import { useSettingsStore, AI_DOCK_WIDTH_MIN } from "./stores/settingsStore";
import { useDockerTopbarStore } from "./stores/dockerTopbarStore";
import { useProtocolTopbarStore } from "./stores/protocolTopbarStore";
import { ProtocolNewTabDialog } from "./modules/protocol/ProtocolNewTabDialog";
import { DASHBOARD_PATH, MODULE_PATHS, WORKSPACE_PATHS, isWorkspacePath, moduleKeyFromPath } from "./lib/paths";
import { getNavVisibleModuleKeys, isModuleOpen, useAppModuleStore } from "./stores/appModuleStore";
import { SshToTerminalRedirect } from "./modules/terminal/SshToTerminalRedirect";
import { startAutoNameSubscription } from "./modules/terminal/sessionAutoName";
import {
  bootstrapTerminalHistory,
  startTerminalHistorySync,
} from "./modules/terminal/terminalHistorySync";
import { useTerminalStore } from "./stores/terminalStore";
import { useTerminalHistoryStore } from "./stores/terminalHistoryStore";
import { startWindowBoundsTracking } from "./lib/windowBoundsPersist";
import {
  LazyDashboardPage,
  LazyDatabasePanel,
  LazyDockerPanel,
  LazyFilesPanel,
  LazyKnowledgePanel,
  LazyProtocolPanel,
  LazyServerPanel,
  LazyTerminalPanel,
  LazyUserWorkspace,
  LazyWorkflowPanel,
  preloadModuleChunks,
} from "./routes/lazyModules";

function TopbarPageActions() {
  const { t } = useI18n();
  const location = useLocation();
  const path = location.pathname;
  const dockerRefreshing = useDockerTopbarStore((s) => s.refreshing);
  const requestDockerRefresh = useDockerTopbarStore((s) => s.requestRefresh);
  const triggerNewRequest = useProtocolTopbarStore((state) => state.triggerNewRequest);
  const requestNewTabPicker = useProtocolTopbarStore((state) => state.requestNewTabPicker);

  if (path === MODULE_PATHS.terminal) {
    return null;
  }

  if (path === MODULE_PATHS.protocol) {
    return (
      <>
        <Button variant="icon" title={t("protocol.actions.newRequest")} onClick={triggerNewRequest}>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
        </Button>
        <Button variant="icon" title={t("protocol.actions.importCurl")}>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
            <path d="M7 10l5 5 5-5" />
            <path d="M12 15V3" />
          </svg>
        </Button>
        <Button variant="primary" size="sm" onClick={() => requestNewTabPicker()}>
          {t("protocol.actions.newTab")}
        </Button>
      </>
    );
  }

  if (path === MODULE_PATHS.docker) {
    return (
      <Button
        variant="icon"
        title={t("common.refresh")}
        aria-label={t("common.refresh")}
        disabled={dockerRefreshing}
        onClick={requestDockerRefresh}
      >
        <svg
          className={dockerRefreshing ? "icon-spin" : undefined}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          width="16"
          height="16"
        >
          <path d="M21 12a9 9 0 1 1-2.64-6.36" />
          <path d="M21 3v6h-6" />
        </svg>
      </Button>
    );
  }

  if (isWorkspacePath(path) || path === DASHBOARD_PATH || path === MODULE_PATHS.workflow) {
    return null;
  }

  return null;
}

/** 原在顶栏注册 Tab 的路由（Tab 已迁入各模块 DockableWorkspace） */
const TOPBAR_TAB_ROUTES: string[] = [
  MODULE_PATHS.terminal,
  MODULE_PATHS.database,
  MODULE_PATHS.docker,
  MODULE_PATHS.ssh,
  MODULE_PATHS.server,
  MODULE_PATHS.protocol,
];

function AppShell() {
  useAiDrawerShortcut();
  useBottomWorkspaceShortcut();
  useSettingsShortcut();
  useGlobalShortcuts();
  const { t } = useI18n();

  useEffect(() => {
    const stopHistorySync = startTerminalHistorySync();
    const stopAutoName = startAutoNameSubscription();
    return () => {
      stopHistorySync();
      stopAutoName();
    };
  }, []);

  // 等 terminalStore 水合后再灌历史，避免 sessions 仍为空时错过恢复
  useEffect(() => {
    let cancelled = false;
    let lastKey = "";

    const runBootstrap = () => {
      if (cancelled) return;
      const sessionIds = useTerminalStore
        .getState()
        .sessions.filter((session) => session.lifecycle !== "ended")
        .map((session) => session.id);
      const key = sessionIds.join("\0");
      if (key === lastKey) return;
      lastKey = key;
      if (sessionIds.length === 0) return;
      bootstrapTerminalHistory(sessionIds);
      const activeId = useTerminalStore.getState().activeSessionId;
      if (activeId) {
        void useTerminalHistoryStore.getState().restoreSession(activeId);
      }
    };

    if (useTerminalStore.persist.hasHydrated()) {
      runBootstrap();
    }
    const unsubHydration = useTerminalStore.persist.onFinishHydration(runBootstrap);
    const unsubSessions = useTerminalStore.subscribe((state, prev) => {
      if (state.sessions === prev.sessions) return;
      runBootstrap();
    });
    return () => {
      cancelled = true;
      unsubHydration();
      unsubSessions();
    };
  }, []);

  // 启动时同步 embedding 配置，供 Skill MCP 向量化 / 混合召回使用
  useEffect(() => {
    void import("./lib/syncEmbeddingProvider").then(({ syncEmbeddingProviderToBackend }) => {
      void syncEmbeddingProviderToBackend();
    });
  }, []);

  // 主窗口：与工作区独立窗口保持同步（打开/关闭时更新 poppedOut 集合）。
  useEffect(() => {
    let cleanup: (() => void) | null = null;
    void initMainWindowWorkspaceSync().then((fn) => {
      cleanup = fn;
    });
    return () => cleanup?.();
  }, []);

  // 主窗口：关闭行为（托盘 / 退出）+ 系统托盘
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let unlisten: (() => void) | undefined;
    void ensureSystemTray({
      tooltip: "OmniPanel",
      showAll: t("shell.closeBehavior.trayShowAll"),
      quit: t("shell.closeBehavior.trayQuit"),
    });
    getCurrentWindow()
      .onCloseRequested(async (event) => {
        await handleWindowCloseRequested(event, "main");
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => unlisten?.();
  }, [t]);

  // 主窗口几何记忆
  useEffect(() => {
    if (!isTauriRuntime()) return;
    return startWindowBoundsTracking({ role: "main" });
  }, []);

  useEffect(() => {
    return subscribePersistStoreCrossWindow("omnipanel-settings", useSettingsStore);
  }, []);

  useCrossWindowDragInit();

  useEffect(() => {
    try {
      return initWorkspaceAddSnapshotListener();
    } catch (e) {
      console.warn("[workspaceSnapshotDelivery] init failed", e);
      return () => {};
    }
  }, []);

  // 跨窗口 tab 状态转移监听：接收来自其他窗口的 tab 运行时状态（终端历史 / SQL 文本等）
  useEffect(() => {
    let cleanup: (() => void) | null = null;
    void initTabStateTransferListener().then((fn) => {
      cleanup = fn;
    });
    return () => cleanup?.();
  }, []);

  // 跨窗口同步工作区 dock tabs/layout（Tauri 下始终订阅，弹出独立窗时即可同步）
  useEffect(() => {
    if (!isCrossWindowDragRuntime()) return;
    return subscribePersistStoreCrossWindow(
      "omnipanel.workspace-bottom-dock.v3",
      useWorkspaceBottomDockStore,
    );
  }, []);

  useEffect(() => {
    const schedule = () => preloadModuleChunks();
    if (typeof requestIdleCallback === "function") {
      // 给首页交互留足空闲窗口，避免启动后立刻抢主线程
      const id = requestIdleCallback(schedule, { timeout: 12000 });
      return () => cancelIdleCallback(id);
    }
    const timer = window.setTimeout(schedule, 2500);
    return () => window.clearTimeout(timer);
  }, []);

  // 空闲预热终端：先拉 chunk，再低优先级挂载壳（suspended，不建 xterm）
  useEffect(() => scheduleIdleTerminalWarm(), []);
  // 空闲预热数据库模块壳，避免重启后首次点侧栏「数据库」卡在 chunk/挂载
  useEffect(() => scheduleIdleDatabaseWarm(), []);

  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    let unreg: (() => void) | undefined;
    void import("./lib/ai/uiFollow").then(({ registerUiFollowNavigate }) => {
      unreg = registerUiFollowNavigate((path) => {
        navigate(path);
      });
    });
    return () => {
      unreg?.();
    };
  }, [navigate]);

  // 当前工作区已弹出为独立窗口时，仅收起主窗底栏；不强制跳转首页。
  useEffect(() => {
    let cancelled = false;
    const handle = () => {
      const curId = useWorkspaceStore.getState().workspace.id;
      if (!useWorkspaceWindowStore.getState().isPoppedOut(curId)) return;
      syncEmbeddedWorkspacePanelVisibility(curId);
      void (async () => {
        try {
          const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
          const { workspaceWindowLabel } = await import("./lib/workspaceWindow");
          const existing = await WebviewWindow.getByLabel(workspaceWindowLabel(curId));
          if (cancelled) return;
          if (!existing) {
            useWorkspaceWindowStore.getState().clearPoppedOut(curId);
          }
        } catch {
          if (!cancelled) {
            useWorkspaceWindowStore.getState().clearPoppedOut(curId);
          }
        }
      })();
    };
    handle();
    const unsub = useWorkspaceWindowStore.subscribe(handle);
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  const title = getRouteTitle(location.pathname);
  const openSettings = useSettingsUiStore((s) => s.openSettings);
  const isTerminal = location.pathname === MODULE_PATHS.terminal;
  const isDocker = location.pathname === MODULE_PATHS.docker;
  const isDatabase = location.pathname === MODULE_PATHS.database;
  const isFiles = location.pathname === MODULE_PATHS.files;
  const isServer = location.pathname === MODULE_PATHS.server;
  const isProtocol = location.pathname === MODULE_PATHS.protocol;
  const isWorkflow = location.pathname === MODULE_PATHS.workflow;
  const isKnowledge = location.pathname === MODULE_PATHS.knowledge;
  const isShellRoute = isShellRoutePath(location.pathname);

  // 叠层模块按需挂载：启动时不全量挂载，避免首页主线程被终端/数据库等重型面板堵死
  const [overlayMounted, setOverlayMounted] = useState(() =>
    createInitialOverlayMounted(location.pathname),
  );

  useEffect(() => {
    const key = moduleKeyFromPath(location.pathname);
    if (isOverlayModuleKey(key)) {
      setOverlayMounted((prev) =>
        prev[key] ? prev : { ...prev, [key]: true },
      );
    }
  }, [location.pathname]);

  // 悬停 / 空闲预热：提前挂载模块壳（路由未激活时仍 suspended）
  useEffect(() => {
    return subscribeModuleShellWarm((key) => {
      startTransition(() => {
        setOverlayMounted((prev) =>
          prev[key] ? prev : { ...prev, [key]: true },
        );
      });
    });
  }, []);

  // 工作区已有数据库 Tab 时预挂载，避免切到其他功能后底部 SQL 失效
  useEffect(() => {
    const { tabsByWorkspace } = useWorkspaceBottomDockStore.getState();
    for (const tabs of Object.values(tabsByWorkspace)) {
      for (const tab of tabs ?? []) {
        if (
          (tab.kind === "mirrored" && tab.originScope === "database") ||
          (tab.kind === "payload" && tab.payload?.module === "database")
        ) {
          setOverlayMounted((prev) =>
            prev.database ? prev : { ...prev, database: true },
          );
          return;
        }
      }
    }
  }, []);

  const aiDisplayMode = useSettingsStore((s) => s.aiDisplayMode);
  const drawerOpen = useAiStore((s) => s.drawerOpen);
  const setActivePath = useWorkspaceStore((state) => state.setActivePath);
  const workspaceActivePath = useWorkspaceStore((state) => state.activePath);
  const confirmAction = useActionStore((state) => state.confirmAction);
  const cancelAction = useActionStore((state) => state.cancelAction);
  const pendingRiskActionId = useActionStore(
    (state) => state.pendingRiskActionId,
  );
  const pendingRiskAction = getPendingRiskAction();
  const appModules = useAppModuleStore((s) => s.modules);
  const appModulesHydrated = useAppModuleStore((s) => s.hydrated);

  useEffect(() => {
    if (location.pathname !== "/settings") return;
    openSettings();
    const fallback =
      workspaceActivePath && workspaceActivePath !== "/settings"
        ? workspaceActivePath
        : MODULE_PATHS.terminal;
    navigate(fallback, { replace: true });
  }, [location.pathname, navigate, openSettings, workspaceActivePath]);

  useEffect(() => {
    if (!appModulesHydrated) return;
    const key = moduleKeyFromPath(location.pathname);
    if (!key || isModuleOpen(key)) return;
    const visible = getNavVisibleModuleKeys();
    const fallback =
      visible.length > 0 ? MODULE_PATHS[visible[0]] : DASHBOARD_PATH;
    navigate(fallback, { replace: true });
  }, [location.pathname, navigate, appModules, appModulesHydrated]);

  useEffect(() => {
    if (!isWorkspacePath(location.pathname)) {
      setActivePath(location.pathname);
    }
  }, [location.pathname, setActivePath]);

  useEffect(() => {
    const bootToHome = () => {
      const { workspaceMode, embeddedMode } = useBottomPanelStore.getState();
      if (
        embeddedMode === "half" ||
        workspaceMode === "half" ||
        workspaceMode === "thumbnail" ||
        workspaceMode === "taskbar"
      ) {
        return;
      }
      goWorkspaceHome();
    };
    if (useBottomPanelStore.persist.hasHydrated()) {
      bootToHome();
      return;
    }
    return useBottomPanelStore.persist.onFinishHydration(bootToHome);
  }, []);

  // 根路径重定向到看板
  useEffect(() => {
    if (location.pathname !== "/") return;
    navigate(DASHBOARD_PATH, { replace: true });
  }, [location.pathname, navigate]);

  const protocolNewTabPickerOpen = useProtocolTopbarStore((s) => s.newTabPickerOpen);
  const setProtocolNewTabPickerOpen = useProtocolTopbarStore((s) => s.setNewTabPickerOpen);

  useEffect(() => {
    if (!isProtocol && protocolNewTabPickerOpen) {
      setProtocolNewTabPickerOpen(false);
    }
  }, [isProtocol, protocolNewTabPickerOpen, setProtocolNewTabPickerOpen]);

  useEffect(() => {
    if (!TOPBAR_TAB_ROUTES.includes(location.pathname)) {
      useTopbarStore.getState().clearTabs();
    }
  }, [location.pathname]);

  useEffect(() => {
    const handler = (event: Event) => {
      const path = (event as CustomEvent<{ path: string }>).detail?.path;
      if (!path) return;
      if (isWorkspacePath(path)) {
        navigate(path);
      } else {
        navigateToFeature(path, navigate);
      }
    };
    window.addEventListener("omnipanel-navigate", handler);
    return () => window.removeEventListener("omnipanel-navigate", handler);
  }, [navigate]);

  const riskResult: DangerCheckResult | null = pendingRiskAction
    ? (pendingRiskAction.riskCheck ?? {
        safe: false,
        level: pendingRiskAction.risk,
        matches: [
          { desc: "当前资源环境需要人工确认", level: pendingRiskAction.risk },
        ],
      })
    : null;

  const aiDockWidth = useSettingsStore((s) => s.aiDockWidth);
  const setAiDockWidth = useSettingsStore((s) => s.setAiDockWidth);
  const workspaceMode = useBottomPanelStore((s) => s.workspaceMode);
  const isBottomFullscreen = useBottomPanelStore((s) => s.isFullscreen);
  const workspaceId = useWorkspaceStore((s) => s.workspace.id);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const poppedOutIds = useWorkspaceWindowStore((s) => s.poppedOutIds);
  const hasHostedWorkspace = workspaces.some((ws) => !poppedOutIds.includes(ws.id));
  const isCurrentWorkspacePoppedOut = poppedOutIds.includes(workspaceId);
  const hideMainEmbeddedWorkspace =
    isCurrentWorkspacePoppedOut && !(isBottomFullscreen && hasHostedWorkspace);
  const deferExitPath = useBottomPanelStore((s) => s.deferExitFullscreenUntilPath);
  const wsState = hideMainEmbeddedWorkspace
    ? "off"
    : workspaceShellState(workspaceMode);
  const showBottomFullscreen = isBottomFullscreen && !hideMainEmbeddedWorkspace;

  // 全屏延迟退出：路由 commit 后同一 layout 阶段再解除全屏，避免闪旧页面
  // deferExitPath 入 deps：navigate 同路径 noop 时 pathname 不变，仍需完成退出
  useLayoutEffect(() => {
    useBottomPanelStore.getState().tryCompleteDeferExitFullscreen(location.pathname);
  }, [location.pathname, deferExitPath]);

  const embeddedModeClass =
    !hideMainEmbeddedWorkspace &&
    workspaceMode !== "fullscreen" &&
    workspaceMode !== "hidden"
      ? ` workspace--mode-${workspaceMode}`
      : "";
  const dockWidth =
    aiDisplayMode === "dockview" && drawerOpen ? `${aiDockWidth}px` : "0px";
  const dockOpen = aiDisplayMode === "dockview" && drawerOpen;
  const dragging = useRef(false);

  // 工程工作区全屏时同步 URL 到 /workspace/:id（Logo 先 navigate 看板时勿拉回工作区）
  useEffect(() => {
    if (workspaceMode !== "fullscreen" && workspaceMode !== "home") return;
    if (hideMainEmbeddedWorkspace) return;
    if (isWorkspacePath(location.pathname)) return;
    if (isShellRoutePath(location.pathname) || isOverlayModulePath(location.pathname)) {
      return;
    }
    const id = useWorkspaceStore.getState().workspace.id;
    navigate(WORKSPACE_PATHS.detail(id), { replace: true });
  }, [workspaceMode, location.pathname, navigate]);

  const handleResizeMouseDown = useCallback(() => {
    dragging.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  const handleResizeMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!dragging.current) return;
      const vw = window.innerWidth;
      const maxWidth = Math.round(vw * 0.5);
      const newWidth = Math.max(
        AI_DOCK_WIDTH_MIN,
        Math.min(maxWidth, vw - e.clientX),
      );
      setAiDockWidth(newWidth);
    },
    [setAiDockWidth],
  );

  const handleResizeMouseUp = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, []);

  useEffect(() => {
    window.addEventListener("mousemove", handleResizeMouseMove);
    window.addEventListener("mouseup", handleResizeMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleResizeMouseMove);
      window.removeEventListener("mouseup", handleResizeMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [handleResizeMouseMove, handleResizeMouseUp]);

  const routePanels = (
    <div className="content-routes">
      <OverlayModuleRoutePanel
        active={isTerminal}
        mounted={overlayMounted.terminal}
        keepLayout
      >
        <LazyTerminalPanel />
      </OverlayModuleRoutePanel>
      <OverlayModuleRoutePanel
        active={isDocker}
        mounted={overlayMounted.docker}
      >
        <LazyDockerPanel />
      </OverlayModuleRoutePanel>
      <OverlayModuleRoutePanel
        active={isDatabase}
        mounted={overlayMounted.database}
        keepLayout
      >
        <LazyDatabasePanel />
      </OverlayModuleRoutePanel>
      <OverlayModuleRoutePanel
        active={isFiles}
        mounted={overlayMounted.files}
      >
        <LazyFilesPanel />
      </OverlayModuleRoutePanel>
      <OverlayModuleRoutePanel
        active={isServer}
        mounted={overlayMounted.server}
      >
        <LazyServerPanel />
      </OverlayModuleRoutePanel>
      <OverlayModuleRoutePanel
        active={isProtocol}
        mounted={overlayMounted.protocol}
      >
        <LazyProtocolPanel />
      </OverlayModuleRoutePanel>
      <OverlayModuleRoutePanel
        active={isWorkflow}
        mounted={overlayMounted.workflow}
      >
        <LazyWorkflowPanel />
      </OverlayModuleRoutePanel>
      <OverlayModuleRoutePanel
        active={isKnowledge}
        mounted={overlayMounted.knowledge}
      >
        <LazyKnowledgePanel />
      </OverlayModuleRoutePanel>
      <div className={`route-panel${isShellRoute ? " route-panel--active" : ""}`}>
        <Routes>
            <Route path="/" element={<Navigate to={DASHBOARD_PATH} replace />} />
            <Route
              path={DASHBOARD_PATH}
              element={
                <SuspendedModulePanel active={location.pathname === DASHBOARD_PATH}>
                  <LazyDashboardPage />
                </SuspendedModulePanel>
              }
            />
            <Route
              path={`${WORKSPACE_PATHS.list}/:workspaceId`}
              element={
                <SuspendedModulePanel active={isWorkspacePath(location.pathname)}>
                  <LazyUserWorkspace />
                </SuspendedModulePanel>
              }
            />
            <Route path={MODULE_PATHS.terminal} element={null} />
            <Route
              path={MODULE_PATHS.ssh}
              element={<SshToTerminalRedirect />}
            />
            <Route path={MODULE_PATHS.database} element={null} />
            <Route path={MODULE_PATHS.docker} element={null} />
            <Route path={MODULE_PATHS.server} element={null} />
            <Route path={MODULE_PATHS.protocol} element={null} />
            <Route path={MODULE_PATHS.workflow} element={null} />
            <Route path={MODULE_PATHS.knowledge} element={null} />
            <Route path={MODULE_PATHS.files} element={null} />
            <Route path="*" element={<Navigate to={DASHBOARD_PATH} replace />} />
          </Routes>
      </div>
    </div>
  );

  return (
    <AiRuntimeProvider>
      <div className="app">
      <Sidebar />
      <div
        className={`workspace workspace--${wsState}${showBottomFullscreen ? " workspace--bottom-fullscreen" : ""}${embeddedModeClass}`}
        style={{ "--ai-dock-w": dockWidth } as React.CSSProperties}
      >
        <Topbar title={title} hidden>
          <TopbarPageActions />
        </Topbar>
        <div className="workspace-body">
          <div className={`content-area ws-state-${wsState}`}>
            <WorkspaceHost>{routePanels}</WorkspaceHost>
          </div>
          {dockOpen && (
            <div
              className="ai-dockview-resize-handle"
              onMouseDown={handleResizeMouseDown}
            />
          )}
          {aiDisplayMode === "dockview" ? <AiDockView /> : null}
        </div>
        <StatusBar />
      </div>
      {aiDisplayMode !== "dockview" ? <AiDrawer /> : null}
      <CommandPalette />
      <RecentItemsPanel />
      <NotificationDrawer />
      <WindowResize />
      <QuickInputHost />
      {/* 全局应用内 confirm/alert；禁止改回 Tauri 原生 dialog */}
      <AppDialogHost />
      <CloseBehaviorDialogHost />
      <ToastHost />
      <SkillEvolutionPrompt />
      <CrossWindowDragVisualLayer />
      <SettingsWindow />
      <UserCenterWindow />
      <AuthProfileSync />
      <SubWindowMinimizedStack />
      <ResourceProfileSubWindow />
      {pendingRiskActionId && pendingRiskAction && riskResult && (
        <DangerConfirmDialog
          command={pendingRiskAction.command ?? pendingRiskAction.description}
          result={riskResult}
          onConfirm={() => confirmAction(pendingRiskAction.id)}
          onCancel={() => cancelAction(pendingRiskAction.id)}
        />
      )}
      <ProtocolNewTabDialog
        open={protocolNewTabPickerOpen}
        onOpenChange={setProtocolNewTabPickerOpen}
      />
      </div>
    </AiRuntimeProvider>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppShell />
    </BrowserRouter>
  );
}
