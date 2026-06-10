import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAiStore } from "../../stores/aiStore";
import { useTopbarStore } from "../../stores/topbarStore";
import { useI18n } from "../../i18n";
import { formatShortcut, useShortcutsStore } from "../../stores/shortcutsStore";
import type { ReactNode } from "react";
import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { TopbarTabs } from "../ui/TopbarTabs";

interface TopbarProps {
  title: string;
  children?: ReactNode;
}

export function Topbar({ title, children }: TopbarProps) {
  const { t } = useI18n();
  const tabs = useTopbarStore((state) => state.tabs);
  const tabMode = useTopbarStore((state) => state.tabMode);
  const showAddTab = useTopbarStore((state) => state.showAddTab);
  const addTabTitle = useTopbarStore((state) => state.addTabTitle);
  const handlers = useTopbarStore((state) => state.handlers);
  const showGlobalAiButton = true;

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

  const aiDrawerOpen = useAiStore((state) => state.drawerOpen);
  const aiKeysOverride = useShortcutsStore((s) => s.overrides["toggle-ai"]);
  const aiShortcutLabel = useMemo(
    () => formatShortcut(aiKeysOverride ?? ["Mod", "`"]),
    [aiKeysOverride]
  );
  const [isMaximized, setIsMaximized] = useState(false);
  const spacerDragRef = useRef<{ startX: number; startY: number } | null>(null);

  const onSpacerMouseDown = useCallback((e: React.MouseEvent) => {
    spacerDragRef.current = { startX: e.clientX, startY: e.clientY };
  }, []);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      const s = spacerDragRef.current;
      if (!s) return;
      if (Math.abs(e.clientX - s.startX) > 3 || Math.abs(e.clientY - s.startY) > 3) {
        spacerDragRef.current = null;
        getCurrentWindow().startDragging();
      }
    };
    const onMouseUp = () => {
      spacerDragRef.current = null;
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  useEffect(() => {
    const win = getCurrentWindow();
    const update = async () => setIsMaximized(await win.isMaximized());
    update();
    let unlisten: (() => void) | undefined;
    (async () => {
      unlisten = await win.onResized(update);
    })();
    return () => unlisten?.();
  }, []);

  const handleDoubleClick = async (event: React.MouseEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest(".win-controls") || target.closest(".topbar-btn") || target.closest(".topbar-actions")) {
      return;
    }
    const win = getCurrentWindow();
    if (await win.isFullscreen()) {
      await win.setFullscreen(false);
    } else {
      await win.toggleMaximize();
    }
  };

  return (
    <div className="topbar" onDoubleClick={handleDoubleClick}>
      <span className="topbar-title" data-tauri-drag-region>
        {title}
      </span>

      <TopbarTabs
        tabs={tabs}
        tabMode={tabMode}
        showAddTab={showAddTab}
        addTabTitle={addTabTitle}
        handlers={handlers}
      />

      <div className="topbar-spacer" onMouseDown={onSpacerMouseDown} />

      <div className="topbar-right" data-tauri-drag-region="false">
        {children && <div className="topbar-page-actions">{children}</div>}

        <div className="topbar-actions">
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
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M0 5h10" stroke="currentColor" strokeWidth="1.2" />
              </svg>
            </button>
            <button className="win-btn maximize" title={isMaximized ? t("shell.topbar.restore") : t("shell.topbar.maximize")} onClick={handleMaximize}>
              {isMaximized ? (
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <rect x="0.5" y="0.5" width="5.5" height="5.5" stroke="currentColor" strokeWidth="1.2" />
                  <rect x="4" y="4" width="5.5" height="5.5" fill="var(--bg)" stroke="currentColor" strokeWidth="1.2" />
                </svg>
              ) : (
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" strokeWidth="1.2" />
                </svg>
              )}
            </button>
            <button className="win-btn close" title={t("shell.topbar.close")} onClick={handleClose}>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1.2" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
