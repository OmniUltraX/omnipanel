import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTopbarStore } from "../../stores/topbarStore";
import { useI18n } from "../../i18n";
import type { ReactNode } from "react";
import { useEffect, useRef, useCallback } from "react";
import { TopbarTabs } from "../ui/TopbarTabs";
import { WinControls } from "./WinControls";

interface TopbarProps {
  title: string;
  children?: ReactNode;
  /** 隐藏顶栏（终端等模块改用 dockview tab 栏时） */
  hidden?: boolean;
}

export function Topbar({ title, children, hidden = false }: TopbarProps) {
  const { t } = useI18n();
  const tabs = useTopbarStore((state) => state.tabs);
  const tabMode = useTopbarStore((state) => state.tabMode);
  const showAddTab = useTopbarStore((state) => state.showAddTab);
  const addTabTitle = useTopbarStore((state) => state.addTabTitle);
  const handlers = useTopbarStore((state) => state.handlers);

  const handleSearch = () => {
    window.dispatchEvent(new CustomEvent("toggle-cmd-palette"));
  };

  const handleNotifications = () => {
    window.dispatchEvent(new CustomEvent("toggle-notif-drawer"));
  };

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

  if (hidden) {
    return null;
  }

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

          <WinControls />
        </div>
      </div>
    </div>
  );
}
