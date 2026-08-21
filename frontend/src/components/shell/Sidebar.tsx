import { useNavigate, useLocation } from "react-router-dom";
import { startTransition, useCallback, useRef, useState } from "react";
import { useBottomPanelStore } from "../../stores/bottomPanelStore";
import { useI18n } from "../../i18n";
import { AppLogo } from "../ui/layout/AppLogo";
import {
  navigateToFeature,
  toggleWorkspaceFromChromeIcon,
} from "../../lib/workspaceNavigation";
import { isDashboardPath, moduleKeyFromPath } from "../../lib/paths";
import { isOverlayModulePath } from "../../lib/routePanels";
import { scheduleNavHoverWarm } from "../../lib/moduleWarmup";
import { getNavVisibleModuleKeys, useAppModuleStore } from "../../stores/appModuleStore";
import { usePluginRuntimeStore } from "../../stores/pluginRuntimeStore";
import { sidebarItemsForVisible, type SidebarNavItem } from "../../lib/sidebarNav";
import { usePanelLayoutStore } from "../../stores/panelLayoutStore";
import { ContextMenu, type ContextMenuItem } from "../ui/ContextMenu";
import {
  isModuleWindowSupported,
  openModuleWindow,
} from "../../lib/moduleWindow";
import { isTauriRuntime } from "../../lib/isTauriRuntime";
import { usesMacTrafficLights } from "../../lib/platform";
import { SidebarMiniappButton } from "./SidebarMiniappButton";
import { SidebarUserButton } from "./SidebarUserButton";
import { WinControls } from "./WinControls";

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
  useAppModuleStore((s) => s.modules);
  usePluginRuntimeStore((s) => s.items);
  const visibleKeys = getNavVisibleModuleKeys();
  const primaryItems = sidebarItemsForVisible(visibleKeys, "primary");
  const utilItems = sidebarItemsForVisible(visibleKeys, "util");
  const hoverWarmCancelRef = useRef<(() => void) | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    path: string;
  } | null>(null);

  const isActive = (path: string) => {
    if (isWorkspaceHome) return false;
    return location.pathname.startsWith(path);
  };

  const go = (path: string) => {
    // 叠层模块（终端/数据库等）须同步 navigate，避免 startTransition 延迟造成切换钝感
    if (isBottomFullscreen || isOverlayModulePath(path)) {
      navigateToFeature(path, navigate);
      return;
    }
    startTransition(() => {
      navigateToFeature(path, navigate);
    });
  };

  const handleModuleNav = (path: string) => {
    if (!isBottomFullscreen && isActive(path)) {
      usePanelLayoutStore.getState().toggleModuleSidebar();
      return;
    }
    go(path);
  };

  const handleNavHoverStart = (path: string) => {
    hoverWarmCancelRef.current?.();
    hoverWarmCancelRef.current = scheduleNavHoverWarm(path);
  };

  const handleNavHoverEnd = () => {
    hoverWarmCancelRef.current?.();
    hoverWarmCancelRef.current = null;
  };

  const handleOpenInNewWindow = useCallback(
    (path: string) => {
      const moduleKey = moduleKeyFromPath(path);
      if (!moduleKey || !isModuleWindowSupported(moduleKey)) return;
      void openModuleWindow(moduleKey, t(`shell.nav.${moduleKey}`));
    },
    [t],
  );

  const handleModuleContextMenu = (path: string, e: React.MouseEvent) => {
    const moduleKey = moduleKeyFromPath(path);
    if (!moduleKey || !isModuleWindowSupported(moduleKey) || !isTauriRuntime()) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, path });
  };

  const ctxMenuItems: ContextMenuItem[] = ctxMenu
    ? [
        {
          id: "open-in-new-window",
          label: t("shell.nav.openInNewWindow"),
          onClick: () => handleOpenInNewWindow(ctxMenu.path),
        },
      ]
    : [];

  const renderItem = (item: SidebarNavItem) => (
    <button
      key={item.path}
      type="button"
      className={`sidebar-item${isActive(item.path) ? " active" : ""}`}
      title={t(item.i18nKey)}
      onClick={() => handleModuleNav(item.path)}
      onContextMenu={(e) => handleModuleContextMenu(item.path, e)}
      onMouseEnter={() => handleNavHoverStart(item.path)}
      onMouseLeave={handleNavHoverEnd}
      onFocus={() => handleNavHoverStart(item.path)}
      onBlur={handleNavHoverEnd}
    >
      {item.icon}
    </button>
  );

  const isMac = usesMacTrafficLights();
  const logoButton = (
    <button
      type="button"
      className={`sidebar-logo${isWorkspaceHome ? " active" : ""}${isMac ? "" : " window-drag-surface--interactive"}`}
      title={logoTitle}
      data-tauri-drag-region={isMac ? undefined : "false"}
      onClick={() => toggleWorkspaceFromChromeIcon(navigate, location.pathname)}
    >
      <AppLogo size={isMac ? 36 : 28} className="sidebar-logo__img" />
    </button>
  );

  return (
    <aside className={`sidebar${isMac ? " sidebar--mac" : " sidebar--win"}`}>
      {/* 与右侧 Tab 栏同高的顶条：mac 放红绿灯，Windows 放 logo（兼拖拽区），保证顶栏视觉贯通全窗 */}
      <div className="sidebar-top-chrome" data-tauri-drag-region>
        {isMac ? <WinControls className="sidebar-win-controls" /> : logoButton}
      </div>
      {/* mac：红绿灯占顶条，logo 仍在下方导航区 */}
      {isMac ? logoButton : null}

      {primaryItems.map(renderItem)}
      <div className="sidebar-divider" />
      {utilItems.map(renderItem)}

      <div className="sidebar-spacer" />

      <SidebarMiniappButton />
      <SidebarUserButton />

      {ctxMenu ? (
        <ContextMenu
          items={ctxMenuItems}
          position={{ x: ctxMenu.x, y: ctxMenu.y }}
          onClose={() => setCtxMenu(null)}
        />
      ) : null}
    </aside>
  );
}
