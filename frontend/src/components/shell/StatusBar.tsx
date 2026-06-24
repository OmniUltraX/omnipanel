import { useEffect, useState, useCallback } from "react";
import { useLocation } from "react-router-dom";
import { useWorkspaceStore, type WorkspaceInfo } from "../../stores/workspaceStore";
import { switchEmbeddedWorkspace } from "../../lib/workspaceNavigation";
import { useBottomPanelStore, useEmbeddedWorkspaceMode } from "../../stores/bottomPanelStore";
import { getResourceById } from "../../lib/resourceRegistry";
import { isWorkspacePath } from "../../lib/paths";
import { pathnameToModuleKey } from "../../lib/moduleStatusLog";
import { useStatusBarLogStore } from "../../stores/statusBarLogStore";
import { useI18n } from "../../i18n";
import { ConnectionPoolIndicator } from "./ConnectionPoolIndicator";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

/** 订阅当前激活模块的运行日志并展示在状态栏 */
function StatusBarModuleLog() {
  const location = useLocation();
  const setActivePublisher = useStatusBarLogStore((s) => s.setActivePublisher);
  const logEntry = useStatusBarLogStore((s) => {
    const key = s.activePublisher;
    return key ? s.logsByModule[key] : undefined;
  });

  useEffect(() => {
    setActivePublisher(pathnameToModuleKey(location.pathname));
  }, [location.pathname, setActivePublisher]);

  if (!logEntry?.message) {
    return null;
  }

  return (
    <span
      className={`statusbar-log statusbar-log--${logEntry.level}`}
      title={logEntry.message}
    >
      {logEntry.level === "progress" ? (
        <span className="statusbar-dot yellow" aria-hidden />
      ) : null}
      {logEntry.message}
    </span>
  );
}

function StatusBarWorkspacePanelToggle() {
  const { t } = useI18n();
  const embeddedMode = useEmbeddedWorkspaceMode();
  const workspaceDisplayPreference = useBottomPanelStore(
    (state) => state.workspaceDisplayPreference,
  );
  const toggleDisplayMode = useBottomPanelStore(
    (state) => state.toggleWorkspaceDisplayPreference,
  );

  const isHidden = embeddedMode === "hidden";
  const isTaskBar = workspaceDisplayPreference === "task-bar";

  const toggleLabel = isHidden
    ? t("shell.statusbar.expandWorkspace")
    : isTaskBar
      ? t("shell.statusbar.switchToSplitWindow")
      : t("shell.statusbar.switchToTaskBar");

  return (
    <button
      type="button"
      className={`statusbar-item statusbar-button statusbar-workspace-toggle${!isHidden && !isTaskBar ? " statusbar-workspace-toggle--open" : ""}`}
      onClick={() => toggleDisplayMode()}
      title={toggleLabel}
      aria-label={toggleLabel}
      aria-pressed={!isHidden && !isTaskBar}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12" aria-hidden>
        <rect x="3" y="4" width="18" height="16" rx="1.5" />
        <path d="M3 15h18" />
        {isHidden || isTaskBar ? (
          <polyline points="8 11 12 7 16 11" />
        ) : (
          <polyline points="8 18 12 14 16 18" />
        )}
      </svg>
    </button>
  );
}

function StatusBarWorkspaceControls() {
  const requestExpand = useBottomPanelStore((state) => state.requestExpand);

  const handleSelectWorkspace = useCallback(
    (ws: WorkspaceInfo) => {
      switchEmbeddedWorkspace(ws.id);
      requestExpand();
    },
    [requestExpand],
  );

  return (
    <div className="statusbar-workspace-controls">
      <WorkspaceSwitcher
        variant="statusbar"
        placement="above"
        context="embedded"
        onSelectWorkspace={handleSelectWorkspace}
      />
      <StatusBarWorkspacePanelToggle />
    </div>
  );
}

export function StatusBar() {
  const location = useLocation();
  const activeResourceId = useWorkspaceStore((state) => state.activeResourceId);
  const [time, setTime] = useState(() => new Date().toLocaleTimeString("zh-CN", { hour12: false }));

  const activeResource = getResourceById(activeResourceId);
  const showWorkspaceControls = !isWorkspacePath(location.pathname);

  useEffect(() => {
    if (location.pathname !== "/module/terminal") return;
    const timer = window.setInterval(() => {
      setTime(new Date().toLocaleTimeString("zh-CN", { hour12: false }));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [location.pathname]);

  if (location.pathname === "/module/terminal") {
    const terminalState = activeResource?.environment === "local" ? "Local PTY Ready" : "SSH Connected";

    return (
      <div className="statusbar">
        <ConnectionPoolIndicator />
        <StatusBarModuleLog />
        <span className="statusbar-item">
          <span className="statusbar-dot green" />
          {terminalState}
        </span>
        <span className="statusbar-item">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
            <rect x="2" y="7" width="6" height="5" rx="1" />
            <rect x="10" y="7" width="6" height="5" rx="1" />
          </svg>
          {activeResource?.name ?? "prod-web-01"}
        </span>
        <span className="statusbar-item">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 6v6l4 2" />
          </svg>
          {time}
        </span>
        <span className="statusbar-spacer" />
        <span className="statusbar-item" style={{ color: "var(--meta)" }}>
          Ctrl+K: Command Palette
        </span>
        <span className="statusbar-item">GPU: wgpu</span>
        <span className="statusbar-item">UTF-8</span>
        <span className="statusbar-item">LF</span>
        {showWorkspaceControls ? <StatusBarWorkspaceControls /> : null}
      </div>
    );
  }

  return (
    <div className="statusbar">
      <ConnectionPoolIndicator />
      <StatusBarModuleLog />
      <span className="statusbar-spacer" />
      {showWorkspaceControls ? <StatusBarWorkspaceControls /> : null}
    </div>
  );
}
