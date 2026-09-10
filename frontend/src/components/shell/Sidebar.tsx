import { useNavigate, useLocation } from "react-router-dom";
import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import { useBottomPanelStore } from "../../stores/bottomPanelStore";
import { useI18n } from "../../i18n";
import { AppLogo } from "../ui/layout/AppLogo";
import {
  navigateToFeature,
  toggleWorkspaceFromChromeIcon,
} from "../../lib/workspaceNavigation";
import { isDashboardPath, isModulePath, moduleKeyFromPath } from "../../lib/paths";
import { isOverlayModulePath } from "../../lib/routePanels";
import { scheduleNavHoverWarm } from "../../lib/moduleWarmup";
import {
  SIDEBAR_PENDING_BACKSTOP_MS,
  readCurrentPathname,
  shouldClearPendingOnBackstop,
} from "../../lib/sidebarPending";
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
import { IconGrid } from "../ui/icons/Icons";
import { PLUGINS_PATH } from "../../lib/paths";

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
  // 乐观高亮：pointerdown 当帧即点亮，不等路由提交（提交约 70~90ms 才到）。
  // location 落定后由下面 effect 清掉；兜底只处理“根本没导航”（拖拽/右键/未点击），
  // 且必须是 location-aware 的——导航在途中（location 已离开起点，含 transition
  // 慢提交与主线程拥堵乱序）时清除会把高亮打回旧项，造成 B→A→B 回闪。
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const pendingTimerRef = useRef<number | null>(null);
  const pendingRafRef = useRef<number | null>(null);

  const clearPendingTimers = () => {
    if (pendingTimerRef.current) {
      window.clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = null;
    }
    if (pendingRafRef.current) {
      cancelAnimationFrame(pendingRafRef.current);
      pendingRafRef.current = null;
    }
  };

  const markPending = (path: string) => {
    // pointerdown 即预热：触屏/键盘/快点无 hover，click 前能省则省
    scheduleNavHoverWarm(path);
    const fromPath = readCurrentPathname();
    setPendingPath(path);
    clearPendingTimers();
    // 快捷路径：pointerup 后下一帧若 location 纹丝不动，说明是拖拽而非点击，即刻清除
    //（click 若会发生必在 rAF 前提交 location；press-and-hold 的 click 同理）。
    const onPointerUp = () => {
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      if (pendingRafRef.current) cancelAnimationFrame(pendingRafRef.current);
      pendingRafRef.current = requestAnimationFrame(() => {
        pendingRafRef.current = null;
        if (shouldClearPendingOnBackstop(fromPath)) {
          setPendingPath((prev) => (prev === path ? null : prev));
        }
      });
    };
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    // 慢速兜底：窗口失焦/菜单拦截等 rAF 不触发的路径；location 动过则不动 pending。
    pendingTimerRef.current = window.setTimeout(() => {
      pendingTimerRef.current = null;
      if (shouldClearPendingOnBackstop(fromPath)) {
        setPendingPath((prev) => (prev === path ? null : prev));
      }
    }, SIDEBAR_PENDING_BACKSTOP_MS);
  };

  useEffect(() => {
    setPendingPath(null);
    clearPendingTimers();
  }, [location.pathname]);

  useEffect(() => {
    return () => {
      clearPendingTimers();
    };
  }, []);

  const isLocationActive = (path: string) => {
    if (isWorkspaceHome) return false;
    return location.pathname.startsWith(path);
  };

  // 视觉高亮允许乐观态；导航决策必须只看 location（pending 会让"点当前项"恒为真）
  const isActive = (path: string) => {
    if (pendingPath) return pendingPath === path;
    return isLocationActive(path);
  };

  const go = (path: string) => {
    // 所有 /module/*（含插件模块）同步 navigate，避免 startTransition 把切换推入过渡帧
    const sync = isBottomFullscreen || isOverlayModulePath(path) || isModulePath(path);
    // 叠层模块（终端/数据库等）须同步 navigate，避免 startTransition 延迟造成切换钝感
    if (sync) {
      navigateToFeature(path, navigate);
      return;
    }
    startTransition(() => {
      navigateToFeature(path, navigate);
    });
  };

  const handleModuleNav = (path: string) => {
    if (!isBottomFullscreen && isLocationActive(path)) {
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
      onPointerDownCapture={(e) => {
        if (e.button === 0) markPending(item.path);
      }}
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

      <button
        type="button"
        className={`sidebar-item${isActive(PLUGINS_PATH) ? " active" : ""}`}
        title={t("plugins.center.title")}
        aria-label={t("plugins.center.title")}
        onPointerDownCapture={(e) => {
          if (e.button === 0) markPending(PLUGINS_PATH);
        }}
        onClick={() => go(PLUGINS_PATH)}
      >
        <IconGrid size={20} />
      </button>
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
