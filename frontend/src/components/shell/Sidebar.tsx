import { useNavigate, useLocation } from "react-router-dom";
import { startTransition } from "react";
import type { ReactNode } from "react";
import { useAiStore } from "../../stores/aiStore";
import { useSettingsUiStore } from "../../stores/settingsUiStore";
import { useBottomPanelStore } from "../../stores/bottomPanelStore";
import { useI18n } from "../../i18n";
import { AppLogo } from "../ui/AppLogo";
import {
  navigateToFeature,
  toggleWorkspaceFromChromeIcon,
} from "../../lib/workspaceNavigation";
import { isDashboardPath, isModulePathNavVisible, MODULE_PATHS } from "../../lib/paths";

const navPaths = [
  {
    path: MODULE_PATHS.terminal,
    key: "shell.nav.terminal",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M4 17l6-6-6-6" />
        <path d="M12 19h8" />
      </svg>
    ),
  },
  {
    path: MODULE_PATHS.database,
    key: "shell.nav.database",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <ellipse cx="12" cy="5" rx="9" ry="3" />
        <path d="M21 12c0 1.66-4.03 3-9 3s-9-1.34-9-3" />
        <path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5" />
      </svg>
    ),
  },
  {
    path: MODULE_PATHS.ssh,
    key: "shell.nav.ssh",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <path d="M8 21h8M12 17v4" />
      </svg>
    ),
  },
  {
    path: MODULE_PATHS.docker,
    key: "shell.nav.docker",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <rect x="2" y="7" width="6" height="5" rx="1" />
        <rect x="10" y="7" width="6" height="5" rx="1" />
        <rect x="18" y="7" width="4" height="5" rx="1" />
        <rect x="6" y="2" width="6" height="5" rx="1" />
        <path d="M2 17h20c0 2.76-4.48 5-10 5S2 19.76 2 17z" />
      </svg>
    ),
  },
  {
    path: MODULE_PATHS.server,
    key: "shell.nav.server",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <rect x="2" y="2" width="20" height="8" rx="2" />
        <rect x="2" y="14" width="20" height="8" rx="2" />
        <circle cx="6" cy="6" r="1" fill="currentColor" />
        <circle cx="6" cy="18" r="1" fill="currentColor" />
      </svg>
    ),
  },
  {
    path: MODULE_PATHS.files,
    key: "shell.nav.files",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
      </svg>
    ),
  },
];

const utilPaths = [
  {
    path: MODULE_PATHS.protocol,
    key: "shell.nav.protocol",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
      </svg>
    ),
  },
  {
    path: MODULE_PATHS.workflow,
    key: "shell.nav.workflow",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M12 3v18M3 12h18" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    ),
  },
  {
    path: MODULE_PATHS.knowledge,
    key: "shell.nav.knowledge",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M4 19.5A2.5 2.5 0 016.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" />
      </svg>
    ),
  },
];

export function Sidebar() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const isBottomFullscreen = useBottomPanelStore((s) => s.isFullscreen);
  /** 看板或工作区全屏时高亮左上角入口 */
  const isWorkspaceHome =
    isDashboardPath(location.pathname) || isBottomFullscreen;
  const logoTitle = isBottomFullscreen
    ? t("shell.workspacePopover.home")
    : t("shell.workspacePanel.fullscreen");
  const drawerOpen = useAiStore((s) => s.drawerOpen);
  const settingsOpen = useSettingsUiStore((s) => s.open);
  const openSettings = useSettingsUiStore((s) => s.openSettings);

  const isActive = (path: string) => {
    if (isWorkspaceHome) return false;
    return location.pathname.startsWith(path);
  };

  const go = (path: string) => {
    startTransition(() => {
      navigateToFeature(path, navigate);
    });
  };

  const handleModuleNav = (path: string) => {
    go(path);
  };

  const renderItem = (item: { path: string; key: string; icon: ReactNode }) => (
    <button
      key={item.path}
      type="button"
      className={`sidebar-item${isActive(item.path) ? " active" : ""}`}
      title={t(item.key)}
      onClick={() => handleModuleNav(item.path)}
    >
      {item.icon}
    </button>
  );

  return (
    <aside className="sidebar">
      <button
        type="button"
        className={`sidebar-logo${isWorkspaceHome ? " active" : ""}`}
        title={logoTitle}
        onClick={() => toggleWorkspaceFromChromeIcon(navigate)}
      >
        <AppLogo size={36} className="sidebar-logo__img" />
      </button>

      {navPaths.filter((item) => isModulePathNavVisible(item.path)).map(renderItem)}
      <div className="sidebar-divider" />
      {utilPaths.filter((item) => isModulePathNavVisible(item.path)).map(renderItem)}

      <div className="sidebar-spacer" />

      <button
        type="button"
        className={`sidebar-item${drawerOpen ? " active" : ""}`}
        title={t("shell.nav.ai")}
        onClick={() => useAiStore.getState().toggleDrawer()}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M12 2a4 4 0 014 4v1a4 4 0 01-8 0V6a4 4 0 014-4z" />
          <circle cx="18" cy="14" r="0.5" fill="currentColor" />
          <circle cx="6" cy="14" r="0.5" fill="currentColor" />
          <path d="M12 17v4M8 21h8" />
        </svg>
      </button>

      <button
        type="button"
        className={`sidebar-item${settingsOpen ? " active" : ""}`}
        title={t("shell.nav.settings")}
        onClick={() => openSettings()}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
        </svg>
      </button>
    </aside>
  );
}
