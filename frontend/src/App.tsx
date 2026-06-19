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
import { DangerConfirmDialog } from "./components/terminal/DangerConfirmDialog";
import { QuickInputHost } from "./components/ui/QuickInputHost";
import { Button } from "./components/ui/Button";
import { WorkspaceHost } from "./components/workspace/WorkspaceHost";
import { WorkspaceBottomHost } from "./components/workspace/WorkspaceBottomHost";
import { useBottomPanelStore } from "./stores/bottomPanelStore";
import { workspaceShellState } from "./lib/workspaceMode";
import { useWorkspaceBottomDockStore } from "./stores/workspaceBottomDockStore";
import { WindowResize } from "./components/shell/WindowResize";
import { UserWorkspace } from "./modules/workspace/UserWorkspace";
import { TerminalPanel } from "./modules/terminal/TerminalPanel";
import { DatabasePanel } from "./modules/database/DatabasePanel";
import { DockerPanel } from "./modules/docker/DockerPanel";
import { ServerPanel } from "./modules/server/ServerPanel";
import { SshPanel } from "./modules/server/SshPanel";
import { ProtocolPanel } from "./modules/protocol/ProtocolPanel";
import { WorkflowPanel } from "./modules/workflow/WorkflowPanel";
import { KnowledgePanel } from "./modules/knowledge/KnowledgePanel";
import { SettingsWindow } from "./components/settings/SettingsWindow";
import { useSettingsShortcut } from "./hooks/useSettingsShortcut";
import { useSettingsUiStore } from "./stores/settingsUiStore";
import { FilesPanel } from "./modules/files/FilesPanel";
import { useAiStore } from "./stores/aiStore";
import { useAiDrawerShortcut } from "./hooks/useAiDrawerShortcut";
import { useBottomWorkspaceShortcut } from "./hooks/useBottomWorkspaceShortcut";
import { useWorkspaceStore } from "./stores/workspaceStore";
import { navigateToFeature } from "./lib/workspaceNavigation";
import { useActionStore, getPendingRiskAction } from "./stores/actionStore";
import { useTopbarStore } from "./stores/topbarStore";
import { getResourceById } from "./lib/resourceRegistry";
import { openSshTerminalSession } from "./lib/terminalSession";
import type { DangerCheckResult } from "./lib/commandGuard";
import { getRouteTitle, useI18n } from "./i18n";
import { useSettingsStore, AI_DOCK_WIDTH_MIN } from "./stores/settingsStore";
import { useDockerTopbarStore } from "./stores/dockerTopbarStore";
import { MODULE_PATHS, WORKSPACE_PATHS, isWorkspacePath } from "./lib/paths";

function TopbarPageActions() {
  const { t } = useI18n();
  const location = useLocation();
  const path = location.pathname;
  const activeResourceId = useWorkspaceStore((state) => state.activeResourceId);
  const activeResource = getResourceById(activeResourceId);
  const dockerRefresh = useDockerTopbarStore((s) => s.refresh);
  const dockerRefreshing = useDockerTopbarStore((s) => s.refreshing);

  if (path === MODULE_PATHS.terminal) {
    return null;
  }

  if (path === MODULE_PATHS.ssh) {
    return (
      <Button
        variant="primary"
        size="sm"
        onClick={() => {
          if (activeResource?.type === "ssh") {
            openSshTerminalSession(activeResource.id);
          }
        }}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          width="14"
          height="14"
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
        {t("ssh.connect")}
      </Button>
    );
  }

  if (path === MODULE_PATHS.protocol) {
    return (
      <>
        <Button variant="icon" title={t("protocol.actions.newRequest")}>
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
        <Button variant="primary" size="sm">
          {t("protocol.actions.newTab")}
        </Button>
      </>
    );
  }

  if (path === MODULE_PATHS.docker && dockerRefresh) {
    return (
      <Button
        variant="icon"
        title={t("common.refresh")}
        aria-label={t("common.refresh")}
        disabled={dockerRefreshing}
        onClick={dockerRefresh}
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

  if (isWorkspacePath(path) || path === MODULE_PATHS.workflow) {
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
  const [terminalMounted, setTerminalMounted] = useState(isTerminal);
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

  useEffect(() => {
    if (!isTerminal) {
      setOtherRoutesMounted(true);
    }
  }, [isTerminal]);

  useEffect(() => {
    if (isTerminal) {
      setTerminalMounted(true);
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
    if (!isWorkspacePath(location.pathname)) {
      setActivePath(location.pathname);
    }
  }, [location.pathname, setActivePath]);

  useEffect(() => {
    console.log("[route]", location.pathname);
  }, [location.pathname]);

  // 根路径重定向到默认工作区
  useEffect(() => {
    if (location.pathname !== "/") return;
    navigate(WORKSPACE_PATHS.default, { replace: true });
  }, [location.pathname, navigate]);

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
        useWorkspaceStore.getState().setActivePath(path);
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
  const isHomeActive = useBottomPanelStore((s) => s.isHomeActive);
  const isBottomFullscreen = useBottomPanelStore((s) => s.isFullscreen);
  const wsState = workspaceShellState(workspaceMode);
  const embeddedModeClass =
    workspaceMode !== "fullscreen" &&
    workspaceMode !== "home" &&
    workspaceMode !== "hidden"
      ? ` workspace--mode-${workspaceMode}`
      : "";
  const dockWidth =
    aiDisplayMode === "dockview" && drawerOpen ? `${aiDockWidth}px` : "0px";
  const dockOpen = aiDisplayMode === "dockview" && drawerOpen;
  const dragging = useRef(false);

  // 工作区模式 → URL 同步：内部模式切换（任务栏/缩略图/chrome 图标）时保持 URL 一致
  useEffect(() => {
    if (workspaceMode === "home") {
      if (location.pathname !== WORKSPACE_PATHS.default) {
        navigate(WORKSPACE_PATHS.default, { replace: true });
      }
    } else if (workspaceMode === "fullscreen") {
      if (!isWorkspacePath(location.pathname)) {
        const id = useWorkspaceStore.getState().workspace.id;
        navigate(WORKSPACE_PATHS.dashboard(id), { replace: true });
      }
    }
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
        {terminalMounted && <TerminalPanel />}
      </div>
      <div
        className={`route-panel${isDocker ? " route-panel--active" : ""}`}
      >
        {dockerMounted && <DockerPanel />}
      </div>
      <div
        className={`route-panel${isDatabase ? " route-panel--active" : ""}`}
      >
        {databaseMounted && <DatabasePanel />}
      </div>
      <div
        className={`route-panel${!isTerminal && !isDocker && !isDatabase ? " route-panel--active" : ""}`}
      >
        {otherRoutesMounted && (
          <Routes>
            <Route path="/" element={<Navigate to={WORKSPACE_PATHS.default} replace />} />
            <Route path={`${WORKSPACE_PATHS.list}/:workspaceId`} element={<UserWorkspace />} />
            <Route path={MODULE_PATHS.terminal} element={null} />
            <Route path={MODULE_PATHS.ssh} element={<SshPanel />} />
            <Route path={MODULE_PATHS.database} element={null} />
            <Route path={MODULE_PATHS.docker} element={null} />
            <Route path={MODULE_PATHS.server} element={<ServerPanel />} />
            <Route path={MODULE_PATHS.protocol} element={<ProtocolPanel />} />
            <Route path={MODULE_PATHS.workflow} element={<WorkflowPanel />} />
            <Route path={MODULE_PATHS.knowledge} element={<KnowledgePanel />} />
            <Route path={MODULE_PATHS.files} element={<FilesPanel />} />
            <Route path="*" element={<Navigate to={WORKSPACE_PATHS.default} replace />} />
          </Routes>
        )}
      </div>
    </div>
  );

  return (
    <div className="app">
      <Sidebar />
      <div
        className={`workspace workspace--${wsState}${isHomeActive ? " workspace--home-active" : ""}${isBottomFullscreen ? " workspace--bottom-fullscreen" : ""}${embeddedModeClass}`}
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
            <WorkspaceBottomHost
              key={isHomeActive ? "home-workspace" : `engineering-workspace:${currentWorkspaceId}`}
            />
          </div>
        ) : null}
        <StatusBar />
      </div>
      {aiDisplayMode !== "dockview" ? <AiDrawer /> : null}
      <CommandPalette />
      <NotificationDrawer />
      <WindowResize />
      <QuickInputHost />
      <SettingsWindow />
      {pendingRiskActionId && pendingRiskAction && riskResult && (
        <DangerConfirmDialog
          command={pendingRiskAction.command ?? pendingRiskAction.description}
          result={riskResult}
          onConfirm={() => confirmAction(pendingRiskAction.id)}
          onCancel={() => cancelAction(pendingRiskAction.id)}
        />
      )}
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppShell />
    </BrowserRouter>
  );
}
