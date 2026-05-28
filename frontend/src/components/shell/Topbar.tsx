import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAiStore } from "../../stores/aiStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useTopbarStore, type TopbarTabDef } from "../../stores/topbarStore";
import { getResourceById, type EnvironmentTag, type ResourceType } from "../../lib/resourceRegistry";
import { useI18n } from "../../i18n";
import type { ReactNode, MouseEvent } from "react";

interface TopbarProps {
  title: string;
  children?: ReactNode;
}

function tabStatusClass(status?: string) {
  if (status === "connected" || status === "online") return "online";
  if (status === "connecting") return "connecting";
  if (status === "offline") return "offline";
  return "idle";
}

function SegmentTabIcon({ icon }: { icon: TopbarTabDef["icon"] }) {
  if (!icon) return null;
  const props = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, width: 12, height: 12 };
  switch (icon) {
    case "monitor":
      return (
        <svg {...props}>
          <path d="M3 3v18h18" />
          <path d="m19 9-5 5-4-4-3 3" />
        </svg>
      );
    case "processes":
      return (
        <svg {...props}>
          <rect x="3" y="3" width="7" height="7" />
          <rect x="14" y="3" width="7" height="7" />
          <rect x="3" y="14" width="7" height="7" />
          <rect x="14" y="14" width="7" height="7" />
        </svg>
      );
    case "services":
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="3" />
          <path d="M12 1v6M12 17v6M4.22 4.22l4.24 4.24M15.54 15.54l4.24 4.24M1 12h6M17 12h6M4.22 19.78l4.24-4.24M15.54 8.46l4.24-4.24" />
        </svg>
      );
    case "logs":
      return (
        <svg {...props}>
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
          <path d="M14 2v6h6" />
        </svg>
      );
    default:
      return null;
  }
}

export function Topbar({ title, children }: TopbarProps) {
  const { t } = useI18n();
  const tabs = useTopbarStore((s) => s.tabs);
  const tabMode = useTopbarStore((s) => s.tabMode);
  const showAddTab = useTopbarStore((s) => s.showAddTab);
  const addTabTitle = useTopbarStore((s) => s.addTabTitle);
  const handlers = useTopbarStore((s) => s.handlers);
  const activeResourceId = useWorkspaceStore((s) => s.activeResourceId);
  const activeResource = getResourceById(activeResourceId);
  const hasTabs = tabs.length > 0;
  const isSession = tabMode === "session";

  const handleMinimize = async () => {
    await getCurrentWindow().minimize();
  };

  const handleMaximize = async () => {
    await getCurrentWindow().toggleMaximize();
  };

  const handleClose = async () => {
    await getCurrentWindow().close();
  };

  const handleSearch = () => {
    window.dispatchEvent(new CustomEvent("toggle-cmd-palette"));
  };

  const handleNotifications = () => {
    window.dispatchEvent(new CustomEvent("toggle-notif-drawer"));
  };

  const handleAi = () => {
    useAiStore.getState().toggleDrawer();
  };

  const aiDrawerOpen = useAiStore((s) => s.drawerOpen);

  const handleDoubleClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest(".win-controls") || target.closest(".topbar-btn") || target.closest(".topbar-actions")) {
      return;
    }
    getCurrentWindow().toggleMaximize();
  };

  const addTitle =
    addTabTitle ||
    (tabMode === "connection" ? t("shell.topbar.newConnection") : t("shell.topbar.newTab"));

  return (
    <div className="topbar" onDoubleClick={handleDoubleClick} data-tauri-drag-region>
      <span className="topbar-title" data-tauri-drag-region>{title}</span>

      {hasTabs && (
        <div className={`topbar-tabs topbar-tabs--${tabMode}`}>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`topbar-tab${tab.active ? " active" : ""}`}
              onClick={() => handlers.onSelect?.(tab.id)}
            >
              {isSession && tab.status && (
                <span className={`topbar-tab-dot ${tabStatusClass(tab.status)}`} />
              )}
              {tabMode === "segment" && tab.icon && <SegmentTabIcon icon={tab.icon} />}
              <span>{tab.label}</span>
              {tab.badge && (
                <span className={`badge badge-${tab.badge.tone ?? "muted"}`} style={{ marginLeft: 4 }}>
                  {tab.badge.text}
                </span>
              )}
              {isSession && tab.closable !== false && handlers.onClose && (
                <span
                  className="close"
                  onClick={(e) => {
                    e.stopPropagation();
                    handlers.onClose?.(tab.id);
                  }}
                >
                  &times;
                </span>
              )}
            </button>
          ))}
          {showAddTab && handlers.onAdd && (
            <button className="btn-icon topbar-tab-add" title={addTitle} onClick={handlers.onAdd}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          )}
        </div>
      )}

      {!hasTabs && activeResource && (
        <div className="topbar-context" data-tauri-drag-region>
          <span className="topbar-separator">/</span>
          <span className="topbar-resource-type">{t(`resourceType.${activeResource.type as ResourceType}`)}</span>
          <span className="topbar-resource-name">{activeResource.name}</span>
          <span className={`env-badge env-${activeResource.environment}`}>
            {t(`env.${activeResource.environment as EnvironmentTag}`)}
          </span>
        </div>
      )}

      <div className="topbar-spacer" data-tauri-drag-region />

      <div className="topbar-right" data-tauri-drag-region="false">
        {children && <div className="topbar-page-actions">{children}</div>}

        <div className="topbar-actions">
          <button className={`topbar-btn${aiDrawerOpen ? " active" : ""}`} title={t("shell.topbar.aiAssistant")} onClick={handleAi}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M12 2a4 4 0 014 4v1a4 4 0 01-8 0V6a4 4 0 014-4z" />
              <circle cx="18" cy="14" r="0.5" fill="currentColor" />
              <circle cx="6" cy="14" r="0.5" fill="currentColor" />
              <path d="M12 17v4" />
              <path d="M8 21h8" />
            </svg>
          </button>
          <button className="topbar-btn" title={t("shell.topbar.notifications")} onClick={handleNotifications}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 01-3.46 0" />
            </svg>
            <span className="notif-badge">3</span>
          </button>
          <button className="topbar-btn" title={t("shell.topbar.commandPalette")} onClick={handleSearch}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
          </button>

          <div className="win-controls">
            <button className="win-btn minimize" title={t("shell.topbar.minimize")} onClick={handleMinimize}>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M0 5h10" stroke="currentColor" strokeWidth="1.2" /></svg>
            </button>
            <button className="win-btn maximize" title={t("shell.topbar.maximize")} onClick={handleMaximize}>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" strokeWidth="1.2" /></svg>
            </button>
            <button className="win-btn close" title={t("shell.topbar.close")} onClick={handleClose}>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1.2" /></svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
