import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useActionStore } from "../../stores/actionStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useBottomPanelStore } from "../../stores/bottomPanelStore";
import { useStatusBarStore } from "../../stores/statusBarStore";
import { workspaceResources, getResourceById, type EnvironmentTag } from "../../lib/resourceRegistry";
import { useI18n } from "../../i18n";
import { WorkspacePopover } from "./WorkspacePopover";

function StatusBarWorkspaceControls() {
  const { t } = useI18n();
  const workspace = useWorkspaceStore((state) => state.workspace);
  const isOpen = useBottomPanelStore((state) => state.isOpen);
  const isFullscreen = useBottomPanelStore((state) => state.isFullscreen);
  const requestExpand = useBottomPanelStore((state) => state.requestExpand);
  const requestCollapse = useBottomPanelStore((state) => state.requestCollapse);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const panelVisible = isOpen || isFullscreen;
  const toggleLabel = panelVisible
    ? isFullscreen
      ? t("shell.workspacePanel.exitFullscreen")
      : t("shell.statusbar.collapseWorkspace")
    : t("shell.statusbar.expandWorkspace");

  return (
    <div className="statusbar-workspace-controls">
      <button
        ref={buttonRef}
        type="button"
        className={`statusbar-item statusbar-button${open ? " statusbar-button--active" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={workspace.name}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12" aria-hidden>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M3 9h18" />
          <path d="M9 4v5" />
        </svg>
        <span className="statusbar-button-label">{workspace.name}</span>
        <svg
          className="statusbar-button-chevron"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          width="10"
          height="10"
          aria-hidden
        >
          <polyline points="6 15 12 9 18 15" />
        </svg>
      </button>
      <button
        type="button"
        className={`statusbar-item statusbar-button statusbar-workspace-toggle${panelVisible ? " statusbar-workspace-toggle--open" : ""}`}
        onClick={() => (panelVisible ? requestCollapse() : requestExpand())}
        title={toggleLabel}
        aria-label={toggleLabel}
        aria-pressed={panelVisible}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12" aria-hidden>
          <rect x="3" y="4" width="18" height="16" rx="1.5" />
          <path d="M3 15h18" />
          {panelVisible ? (
            <polyline points="8 18 12 14 16 18" />
          ) : (
            <polyline points="8 11 12 7 16 11" />
          )}
        </svg>
      </button>
      {open && (
        <WorkspacePopover
          anchorRef={buttonRef}
          onClose={() => setOpen(false)}
        />
      )}
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

  const onlineCount = workspaceResources.filter((resource) => ["online", "running"].includes(resource.status)).length;
  const blockedCount = actions.filter((action) => action.status === "blocked").length;
  const runningCount = actions.filter((action) => action.status === "running").length;
  const activeResource = getResourceById(activeResourceId);
  const environment = activeResource?.environment ?? "unknown";

  useEffect(() => {
    if (location.pathname !== "/terminal") return;
    const timer = window.setInterval(() => {
      setTime(new Date().toLocaleTimeString("zh-CN", { hour12: false }));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [location.pathname]);

  if (location.pathname === "/terminal") {
    const terminalState = activeResource?.environment === "local" ? "Local PTY Ready" : "SSH Connected";

    return (
      <>
        <div className="statusbar">
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
          <StatusBarWorkspaceControls />
        </div>
      </>
    );
  }

  return (
    <>
      <div className="statusbar">
        <span className="statusbar-item">
          <span className="statusbar-dot green"></span>
          {t("shell.statusbar.resourcesOnline", { count: onlineCount })}
        </span>
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
      <StatusBarWorkspaceControls />
    </div>
    </>
  );
}
