import { BrowserRouter, Routes, Route, useLocation, useNavigate } from "react-router-dom";
import { useServerViewStore } from "./stores/serverViewStore";
import { useEffect, useState } from "react";
import { Sidebar } from "./components/shell/Sidebar";
import { Topbar } from "./components/shell/Topbar";
import { StatusBar } from "./components/shell/StatusBar";
import { CommandPalette } from "./components/shell/CommandPalette";
import { NotificationDrawer } from "./components/shell/NotificationDrawer";
import { AiDrawer } from "./components/ai/AiDrawer";
import { DangerConfirmDialog } from "./components/terminal/DangerConfirmDialog";
import { QuickInputHost } from "./components/ui/QuickInputHost";
import { Button } from "./components/ui/Button";
import { WindowResize } from "./components/shell/WindowResize";
import { Dashboard } from "./modules/workspace/Dashboard";
import { TerminalPanel } from "./modules/terminal/TerminalPanel";
import { DatabasePanel } from "./modules/database/DatabasePanel";
import { DockerPanel } from "./modules/docker/DockerPanel";
import { ServerPanel } from "./modules/server/ServerPanel";
import { SshRedirect } from "./modules/server/SshRedirect";
import { ProtocolPanel } from "./modules/protocol/ProtocolPanel";
import { WorkflowPanel } from "./modules/workflow/WorkflowPanel";
import { KnowledgePanel } from "./modules/knowledge/KnowledgePanel";
import { TasksPanel } from "./modules/tasks/TasksPanel";
import { FileEditorPanel } from "./modules/editor/FileEditorPanel";
import { SettingsPanel } from "./modules/settings/SettingsPanel";
import { AiAgentPanel } from "./modules/ai";
import { useAiDrawerShortcut } from "./hooks/useAiDrawerShortcut";
import { useWorkspaceStore } from "./stores/workspaceStore";
import { useActionStore, getPendingRiskAction } from "./stores/actionStore";
import { useTopbarStore } from "./stores/topbarStore";
import { useDbToolboxStore } from "./stores/dbToolboxStore";
import { getResourceById } from "./lib/resourceRegistry";
import { openSshTerminalSession } from "./lib/terminalSession";
import type { DangerCheckResult } from "./lib/commandGuard";
import { getRouteTitle, useI18n } from "./i18n";

function TopbarPageActions() {
  const { t } = useI18n();
  const location = useLocation();
  const path = location.pathname;
  const activeResourceId = useWorkspaceStore((state) => state.activeResourceId);
  const activeResource = getResourceById(activeResourceId);

  if (path === "/terminal") {
    return null;
  }

  if (path === "/database") {
    return (
      <Button
        variant="icon"
        title={t("database.toolbox.open")}
        aria-label={t("database.toolbox.open")}
        onClick={() => useDbToolboxStore.getState().setOpen(true)}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="18" height="18">
          <path d="M21 13v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5" />
          <path d="M7 13V6a2 2 0 012-2h6a2 2 0 012 2v7" />
          <path d="M9 13h6" />
          <path d="M12 4V2" />
        </svg>
      </Button>
    );
  }

  if (path === "/server" && useServerViewStore.getState().viewTab === "terminal") {
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
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
          <path d="M12 5v14M5 12h14" />
        </svg>
        {t("ssh.connect")}
      </Button>
    );
  }

  if (path === "/tasks") {
    return (
      <Button variant="ghost" size="sm" onClick={() => useActionStore.getState().clearCompleted()}>
        {t("tasks.actions.clearCompleted")}
      </Button>
    );
  }

  if (path === "/protocol") {
    return (
      <>
        <Button variant="icon" title={t("protocol.actions.newRequest")}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </Button>
        <Button variant="icon" title={t("protocol.actions.importCurl")}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
            <path d="M7 10l5 5 5-5" />
            <path d="M12 15V3" />
          </svg>
        </Button>
        <Button variant="primary" size="sm">{t("protocol.actions.newTab")}</Button>
      </>
    );
  }

  if (path === "/" || path === "/workflow") {
    return null;
  }

  return null;
}

const TOPBAR_TAB_ROUTES = ["/terminal", "/database", "/docker", "/server", "/tasks", "/protocol"];

function AppShell() {
  useAiDrawerShortcut();
  const location = useLocation();
  const navigate = useNavigate();
  const title = getRouteTitle(location.pathname);
  const isTerminal = location.pathname === "/terminal";
  const [otherRoutesMounted, setOtherRoutesMounted] = useState(!isTerminal);
  const [terminalMounted, setTerminalMounted] = useState(isTerminal);
  const setActivePath = useWorkspaceStore((state) => state.setActivePath);
  const confirmAction = useActionStore((state) => state.confirmAction);
  const cancelAction = useActionStore((state) => state.cancelAction);
  const pendingRiskActionId = useActionStore((state) => state.pendingRiskActionId);
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
    setActivePath(location.pathname);
  }, [location.pathname, setActivePath]);

  useEffect(() => {
    if (!TOPBAR_TAB_ROUTES.includes(location.pathname)) {
      useTopbarStore.getState().clearTabs();
    }
    if (location.pathname !== "/database") {
      useDbToolboxStore.getState().setOpen(false);
    }
  }, [location.pathname]);

  useEffect(() => {
    const handler = (event: Event) => {
      const path = (event as CustomEvent<{ path: string }>).detail?.path;
      if (path) navigate(path);
    };
    window.addEventListener("omnipanel-navigate", handler);
    return () => window.removeEventListener("omnipanel-navigate", handler);
  }, [navigate]);

  const riskResult: DangerCheckResult | null = pendingRiskAction
    ? pendingRiskAction.riskCheck ?? {
        safe: false,
        level: pendingRiskAction.risk,
        matches: [{ desc: "当前资源环境需要人工确认", level: pendingRiskAction.risk }],
      }
    : null;

  return (
    <div className="app">
      <Sidebar />
      <div className="main-content">
        <Topbar title={title}>
          <TopbarPageActions />
        </Topbar>
        <div className="content-area">
          <div className="content-routes">
            <div className={`route-panel${isTerminal ? " route-panel--active" : ""}`}>
              {terminalMounted && <TerminalPanel />}
            </div>
            <div className={`route-panel${!isTerminal ? " route-panel--active" : ""}`}>
              {otherRoutesMounted && (
                <Routes>
                  <Route path="/" element={<Dashboard />} />
                  <Route path="/terminal" element={null} />
                  <Route path="/ssh" element={<SshRedirect />} />
                  <Route path="/database" element={<DatabasePanel />} />
                  <Route path="/docker" element={<DockerPanel />} />
                  <Route path="/server" element={<ServerPanel />} />
                  <Route path="/protocol" element={<ProtocolPanel />} />
                  <Route path="/workflow" element={<WorkflowPanel />} />
                  <Route path="/knowledge" element={<KnowledgePanel />} />
                  <Route path="/tasks" element={<TasksPanel />} />
                  <Route path="/ai-agent" element={<AiAgentPanel />} />
                  <Route path="/settings" element={<SettingsPanel />} />
                  <Route path="/editor" element={<FileEditorPanel />} />
                </Routes>
              )}
            </div>
          </div>
        </div>
        <StatusBar />
      </div>
      <AiDrawer />
      <CommandPalette />
      <NotificationDrawer />
      <WindowResize />
      <QuickInputHost />
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
