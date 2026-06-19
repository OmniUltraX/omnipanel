import { useEffect, useState, useCallback } from "react";
import { useLocation } from "react-router-dom";
import { useActionStore } from "../../stores/actionStore";
import { useWorkspaceStore, type WorkspaceInfo } from "../../stores/workspaceStore";
import { useWorkspacePreviewCollapseStore } from "../../stores/workspacePreviewCollapseStore";
import { useStatusBarStore } from "../../stores/statusBarStore";
import { getResourceById, type EnvironmentTag } from "../../lib/resourceRegistry";
import { isWorkspacePath } from "../../lib/paths";
import { useI18n } from "../../i18n";
import { ConnectionPoolIndicator } from "./ConnectionPoolIndicator";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

function StatusBarWorkspacePanelToggle() {
  const { t } = useI18n();
  const isOpen = useWorkspacePreviewCollapseStore((state) => state.isOpen);
  const toggle = useWorkspacePreviewCollapseStore((state) => state.toggle);

  const toggleLabel = isOpen
    ? t("shell.statusbar.collapseWorkspace")
    : t("shell.statusbar.expandWorkspace");

  return (
    <button
      type="button"
      className={`statusbar-item statusbar-button statusbar-workspace-toggle${isOpen ? " statusbar-workspace-toggle--open" : ""}`}
      onClick={() => toggle()}
      title={toggleLabel}
      aria-label={toggleLabel}
      aria-pressed={isOpen}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12" aria-hidden>
        <rect x="3" y="4" width="18" height="16" rx="1.5" />
        <path d="M3 15h18" />
        {isOpen ? (
          <polyline points="8 18 12 14 16 18" />
        ) : (
          <polyline points="8 11 12 7 16 11" />
        )}
      </svg>
    </button>
  );
}

function StatusBarWorkspaceControls() {
  const switchWorkspace = useWorkspaceStore((state) => state.switchWorkspace);
  const expandPreview = useWorkspacePreviewCollapseStore((state) => state.expand);

  const handleSelectWorkspace = useCallback(
    (ws: WorkspaceInfo) => {
      switchWorkspace(ws.id);
      expandPreview();
    },
    [switchWorkspace, expandPreview],
  );

  return (
    <div className="statusbar-workspace-controls">
      <WorkspaceSwitcher
        variant="statusbar"
        placement="above"
        onSelectWorkspace={handleSelectWorkspace}
      />
      <StatusBarWorkspacePanelToggle />
    </div>
  );
}

export function StatusBar() {
  const { t } = useI18n();
  const location = useLocation();
  const activeResourceId = useWorkspaceStore((state) => state.activeResourceId);
  const actions = useActionStore((state) => state.actions);
  const statusHint = useStatusBarStore((state) => state.hint);
  const [time, setTime] = useState(() => new Date().toLocaleTimeString("zh-CN", { hour12: false }));

  const blockedCount = actions.filter((action) => action.status === "blocked").length;
  const runningCount = actions.filter((action) => action.status === "running").length;
  const activeResource = getResourceById(activeResourceId);
  const environment = activeResource?.environment ?? "unknown";
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
      <>
        <div className="statusbar">
        <ConnectionPoolIndicator />
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
      </>
    );
  }

  return (
    <>
      <div className="statusbar">
        <ConnectionPoolIndicator />
      <span className="statusbar-item">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
          <rect x="2" y="7" width="6" height="5" rx="1" />
          <rect x="10" y="7" width="6" height="5" rx="1" />
        </svg>
        {t("shell.statusbar.current", {
          name: activeResource?.name ?? t("shell.statusbar.noResource"),
        })}
      </span>
      <span className="statusbar-item">
        {t("shell.statusbar.environment", { env: t(`env.${environment as EnvironmentTag}`) })}
      </span>
      <span className="statusbar-item">{t("shell.statusbar.runningTasks", { count: runningCount })}</span>
      <span className="statusbar-item">{t("shell.statusbar.pendingConfirm", { count: blockedCount })}</span>
      {statusHint && (
        <span className="statusbar-item">
          <span className="statusbar-dot yellow" />
          {statusHint}
        </span>
      )}
      <span className="statusbar-spacer"></span>
      <span className="statusbar-item" style={{ color: "var(--meta)" }}>
        {t("shell.statusbar.commandPaletteHint")}
      </span>
      {showWorkspaceControls ? <StatusBarWorkspaceControls /> : null}
    </div>
    </>
  );
}
