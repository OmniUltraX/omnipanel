import { BrowserRouter, Routes, Route, useLocation } from "react-router-dom";
import { useEffect, useState } from "react";
import { Sidebar } from "./components/shell/Sidebar";
import { Topbar } from "./components/shell/Topbar";
import { StatusBar } from "./components/shell/StatusBar";
import { CommandPalette } from "./components/shell/CommandPalette";
import { NotificationDrawer } from "./components/shell/NotificationDrawer";
import { AiDrawer, AiPinnedPanel } from "./components/ai/AiDrawer";
import { DangerConfirmDialog } from "./components/terminal/DangerConfirmDialog";
import { WindowResize } from "./components/shell/WindowResize";
import { Dashboard } from "./modules/workspace/Dashboard";
import { TerminalPanel } from "./modules/terminal/TerminalPanel";
import { SshManager } from "./modules/ssh/SshManager";
import { DatabasePanel } from "./modules/database/DatabasePanel";
import { DockerPanel } from "./modules/docker/DockerPanel";
import { ServerPanel } from "./modules/server/ServerPanel";
import { ProtocolPanel } from "./modules/protocol/ProtocolPanel";
import { WorkflowPanel } from "./modules/workflow/WorkflowPanel";
import { KnowledgePanel } from "./modules/knowledge/KnowledgePanel";
import { TasksPanel } from "./modules/tasks/TasksPanel";
import { SettingsPanel } from "./modules/settings/SettingsPanel";
import { useAiStore } from "./stores/aiStore";
import { useWorkspaceStore } from "./stores/workspaceStore";
import { useActionStore, getPendingRiskAction } from "./stores/actionStore";
import { useTopbarStore } from "./stores/topbarStore";
import { getResourceById } from "./lib/resourceRegistry";
import type { DangerCheckResult } from "./lib/commandGuard";
import { getRouteTitle, useI18n } from "./i18n";

function TopbarPageActions() {
  const { t } = useI18n();
  const location = useLocation();
  const path = location.pathname;
  const openAi = () => useAiStore.getState().openDrawer();
  const enqueueAction = useActionStore((s) => s.enqueueAction);
  const activeResourceId = useWorkspaceStore((s) => s.activeResourceId);
  const activeResource = getResourceById(activeResourceId);

  if (path === "/terminal") {
    return (
      <>
        <button className="btn-icon" title="Split Horizontal">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M3 12h18" />
          </svg>
        </button>
        <button className="btn-icon" title="Split Vertical">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M12 3v18" />
          </svg>
        </button>
        <button
          className="btn-icon"
          title="Search (Ctrl+Shift+F)"
          onClick={() => window.dispatchEvent(new CustomEvent("toggle-terminal-search"))}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
        </button>
        <button className="btn-icon" title={t("shell.topbar.aiAssistant")} onClick={openAi}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M12 2a4 4 0 014 4v1a4 4 0 01-8 0V6a4 4 0 014-4z" />
            <path d="M12 17v4M8 21h8" />
          </svg>
        </button>
      </>
    );
  }

  if (path === "/database") {
    return (
      <>
        <button className="btn btn-secondary btn-sm">{t("common.import")}</button>
        <button className="btn btn-secondary btn-sm">{t("common.export")}</button>
      </>
    );
  }

  if (path === "/ssh") {
    return (
      <button className="btn btn-primary btn-sm">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
          <path d="M12 5v14M5 12h14" />
        </svg>
        {t("ssh.connect")}
      </button>
    );
  }

  if (path === "/tasks") {
    return (
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => useActionStore.getState().clearCompleted()}>
        {t("tasks.actions.clearCompleted")}
      </button>
    );
  }

  if (path === "/protocol") {
    return (
      <>
        <button type="button" className="btn-icon" title={t("protocol.actions.newRequest")}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
        <button type="button" className="btn-icon" title={t("protocol.actions.importCurl")}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
            <path d="M7 10l5 5 5-5" />
            <path d="M12 15V3" />
          </svg>
        </button>
        <button type="button" className="btn btn-primary btn-sm">{t("protocol.actions.newTab")}</button>
      </>
    );
  }

  if (path === "/" || path === "/workflow") {
    return null;
  }

  return (
    <>
      <button
        className="btn btn-ghost btn-sm"
        onClick={() =>
          enqueueAction({
            type: "workflow",
            title: t("actions.recordContext"),
            description: t("actions.recordContextDesc", {
              name: activeResource?.name ?? t("shell.nav.workspace"),
            }),
            resourceId: activeResource?.id,
            source: "用户",
          })
        }
      >
        {t("shell.topbar.recordContext")}
      </button>
      <button className="btn btn-primary btn-sm" onClick={openAi}>
        {t("shell.topbar.askAi")}
      </button>
    </>
  );
}

const TOPBAR_TAB_ROUTES = ["/terminal", "/ssh", "/database", "/docker", "/server", "/tasks", "/protocol"];

function AppShell() {
  const location = useLocation();
  const title = getRouteTitle(location.pathname);
  const isTerminal = location.pathname === "/terminal";
  const [otherRoutesMounted, setOtherRoutesMounted] = useState(!isTerminal);
  const drawerOpen = useAiStore((s) => s.drawerOpen);
  const drawerMode = useAiStore((s) => s.drawerMode);
  const isPinned = drawerOpen && drawerMode === "pinned";
  const setActivePath = useWorkspaceStore((s) => s.setActivePath);
  const confirmAction = useActionStore((s) => s.confirmAction);
  const cancelAction = useActionStore((s) => s.cancelAction);
  const pendingRiskActionId = useActionStore((s) => s.pendingRiskActionId);
  const pendingRiskAction = getPendingRiskAction();

  useEffect(() => {
    if (!isTerminal) {
      setOtherRoutesMounted(true);
    }
  }, [isTerminal]);

  useEffect(() => {
    setActivePath(location.pathname);
  }, [location.pathname, setActivePath]);

  useEffect(() => {
    if (!TOPBAR_TAB_ROUTES.includes(location.pathname)) {
      useTopbarStore.getState().clearTabs();
    }
  }, [location.pathname]);

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
              <TerminalPanel />
            </div>
            <div className={`route-panel${!isTerminal ? " route-panel--active" : ""}`}>
              {otherRoutesMounted && (
                <Routes>
                  <Route path="/" element={<Dashboard />} />
                  <Route path="/ssh" element={<SshManager />} />
                  <Route path="/database" element={<DatabasePanel />} />
                  <Route path="/docker" element={<DockerPanel />} />
                  <Route path="/server" element={<ServerPanel />} />
                  <Route path="/protocol" element={<ProtocolPanel />} />
                  <Route path="/workflow" element={<WorkflowPanel />} />
                  <Route path="/knowledge" element={<KnowledgePanel />} />
                  <Route path="/tasks" element={<TasksPanel />} />
                  <Route path="/settings" element={<SettingsPanel />} />
                </Routes>
              )}
            </div>
          </div>
          {isPinned && <AiPinnedPanel />}
        </div>
        <StatusBar />
      </div>
      <AiDrawer />
      <CommandPalette />
      <NotificationDrawer />
      <WindowResize />
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
