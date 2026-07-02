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
  useRef,
  useState,
} from "react";
import { Sidebar } from "./components/shell/Sidebar";
import { Topbar } from "./components/shell/Topbar";
import { StatusBar } from "./components/shell/StatusBar";
import { CommandPalette } from "./components/shell/CommandPalette";
import { NotificationDrawer } from "./components/shell/NotificationDrawer";
import { AiDrawer } from "./components/ai/AiDrawer";
import { AiDockView } from "./components/ai/AiDockView";
import { AiRuntimeProvider } from "./components/ai/assistant-ui/AiRuntimeProvider";
import { DangerConfirmDialog } from "./components/terminal/DangerConfirmDialog";
import { AppDialogHost } from "./components/ui/AppDialogHost";
import { QuickInputHost } from "./components/ui/QuickInputHost";
import { ToastHost } from "./components/ui/ToastHost";
import { Button } from "./components/ui/Button";
import { SuspendedModulePanel } from "./components/ui/SuspendedModulePanel";
import { WorkspaceHost } from "./components/workspace/WorkspaceHost";
import { WorkspaceBottomHost } from "./components/workspace/WorkspaceBottomHost";
import { useBottomPanelStore } from "./stores/bottomPanelStore";
import { workspaceShellState } from "./lib/workspaceMode";
import { useWorkspaceBottomDockStore } from "./stores/workspaceBottomDockStore";
import { WindowResize } from "./components/shell/WindowResize";
import { SettingsWindow } from "./components/settings/SettingsWindow";
import { SubWindowMinimizedStack } from "./components/ui/SubWindowMinimizedStack";
import { useSettingsShortcut } from "./hooks/useSettingsShortcut";
import { useSettingsUiStore } from "./stores/settingsUiStore";
import { useAiStore } from "./stores/aiStore";
import { useAiDrawerShortcut } from "./hooks/useAiDrawerShortcut";
import { useBottomWorkspaceShortcut } from "./hooks/useBottomWorkspaceShortcut";
import { useWorkspaceStore } from "./stores/workspaceStore";
import { goWorkspaceHome, navigateToFeature } from "./lib/workspaceNavigation";
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
        <Button variant="primary" size="sm" onClick={requestNewTabPicker}>
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

  const location = useLocation();
  const navigate = useNavigate();
  const title = getRouteTitle(location.pathname);
  const openSettings = useSettingsUiStore((s) => s.openSettings);
  const isTerminal = location.pathname === MODULE_PATHS.terminal;
  const isDocker = location.pathname === MODULE_PATHS.docker;
  const isDatabase = location.pathname === MODULE_PATHS.database;
  const [otherRoutesMounted, setOtherRoutesMounted] = useState(!isTerminal);
  const [dockerMounted, setDockerMounted] = useState(isDocker);
  const [databaseMounted, setDatabaseMounted] = useState(isDatabase);
  const aiDisplayMode = useSettingsStore((s) => s.aiDisplayMode);
  const drawerOpen = useAiStore((s) => s.drawerOpen);
  const setActivePath = useWorkspaceStore((state) => state.setActivePath);
  const currentWorkspaceId = useWorkspaceStore((state) => state.workspace.id);
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
    if (!isTerminal) {
      setOtherRoutesMounted(true);
    }
  }, [isTerminal]);

  useEffect(() => {
    if (isDocker) {
      setDockerMounted(true);
    }
  }, [isDocker]);

  useEffect(() => {
    if (isDatabase) {
      setDatabaseMounted(true);
    }
  }, [isDatabase]);

  // 工作区已有数据库 Tab 时预挂载，避免切到其他功能后底部 SQL 失效
  useEffect(() => {
    const { tabsByWorkspace } = useWorkspaceBottomDockStore.getState();
    for (const tabs of Object.values(tabsByWorkspace)) {
      for (const tab of tabs ?? []) {
        if (
          (tab.kind === "mirrored" && tab.originScope === "database") ||
          (tab.kind === "payload" && tab.payload?.module === "database")
        ) {
          setDatabaseMounted(true);
          return;
        }
      }
    }
  }, []);

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

  const isProtocol = location.pathname === MODULE_PATHS.protocol;
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
  const wsState = workspaceShellState(workspaceMode);
  const embeddedModeClass =
    workspaceMode !== "fullscreen" && workspaceMode !== "hidden"
      ? ` workspace--mode-${workspaceMode}`
      : "";
  const dockWidth =
    aiDisplayMode === "dockview" && drawerOpen ? `${aiDockWidth}px` : "0px";
  const dockOpen = aiDisplayMode === "dockview" && drawerOpen;
  const dragging = useRef(false);

  // 工程工作区全屏时同步 URL 到 /workspace/:id（Logo/面板按钮已直接 navigate 时可跳过）
  useEffect(() => {
    if (workspaceMode !== "fullscreen" && workspaceMode !== "home") return;
    if (isWorkspacePath(location.pathname)) return;
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
      <div
        className={`route-panel${isTerminal ? " route-panel--active" : ""}`}
      >
        <SuspendedModulePanel active={isTerminal} suspendWhenHidden={false}>
          <LazyTerminalPanel />
        </SuspendedModulePanel>
      </div>
      <div
        className={`route-panel${isDocker ? " route-panel--active" : ""}`}
      >
        {dockerMounted && (
          <SuspendedModulePanel active={isDocker}>
            <LazyDockerPanel />
          </SuspendedModulePanel>
        )}
      </div>
      <div
        className={`route-panel${isDatabase ? " route-panel--active" : ""}`}
      >
        {databaseMounted && (
          <SuspendedModulePanel active={isDatabase}>
            <LazyDatabasePanel />
          </SuspendedModulePanel>
        )}
      </div>
      <div
        className={`route-panel${!isTerminal && !isDocker && !isDatabase ? " route-panel--active" : ""}`}
      >
        {otherRoutesMounted && (
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
            <Route
              path={MODULE_PATHS.server}
              element={
                <SuspendedModulePanel active={location.pathname === MODULE_PATHS.server}>
                  <LazyServerPanel />
                </SuspendedModulePanel>
              }
            />
            <Route
              path={MODULE_PATHS.protocol}
              element={
                <SuspendedModulePanel active={location.pathname === MODULE_PATHS.protocol}>
                  <LazyProtocolPanel />
                </SuspendedModulePanel>
              }
            />
            <Route
              path={MODULE_PATHS.workflow}
              element={
                <SuspendedModulePanel active={location.pathname === MODULE_PATHS.workflow}>
                  <LazyWorkflowPanel />
                </SuspendedModulePanel>
              }
            />
            <Route
              path={MODULE_PATHS.knowledge}
              element={
                <SuspendedModulePanel active={location.pathname === MODULE_PATHS.knowledge}>
                  <LazyKnowledgePanel />
                </SuspendedModulePanel>
              }
            />
            <Route
              path={MODULE_PATHS.files}
              element={
                <SuspendedModulePanel active={location.pathname === MODULE_PATHS.files}>
                  <LazyFilesPanel />
                </SuspendedModulePanel>
              }
            />
            <Route path="*" element={<Navigate to={DASHBOARD_PATH} replace />} />
          </Routes>
        )}
      </div>
    </div>
  );

  return (
    <AiRuntimeProvider>
      <div className="app">
      <Sidebar />
      <div
        className={`workspace workspace--${wsState}${isBottomFullscreen ? " workspace--bottom-fullscreen" : ""}${embeddedModeClass}`}
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
        {isBottomFullscreen ? (
          <div className="workspace-bottom-fullscreen-shell">
            <WorkspaceBottomHost key={`engineering-workspace:${currentWorkspaceId}`} />
          </div>
        ) : null}
        <StatusBar />
      </div>
      {aiDisplayMode !== "dockview" ? <AiDrawer /> : null}
      <CommandPalette />
      <NotificationDrawer />
      <WindowResize />
      <QuickInputHost />
      {/* 全局应用内 confirm/alert；禁止改回 Tauri 原生 dialog */}
      <AppDialogHost />
      <ToastHost />
      <SettingsWindow />
      <SubWindowMinimizedStack />
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
