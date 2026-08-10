import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useBottomPanelStore } from "../../stores/bottomPanelStore";
import { useI18n } from "../../i18n";
import { usesMacTrafficLights } from "../../lib/platform";
import { WinControls } from "../shell/WinControls";

interface WorkspaceBottomTitleBarProps {
  /** 全屏模式下显示窗口控制按钮，否则显示全屏按钮 */
  showWinControls?: boolean;
}

export function WorkspaceBottomTitleBar({
  showWinControls = false,
}: WorkspaceBottomTitleBarProps) {
  const { t } = useI18n();
  const workspaceName = useWorkspaceStore((state) => state.workspace.name);
  const enterFullscreen = useBottomPanelStore((state) => state.enterFullscreen);
  const exitFullscreen = useBottomPanelStore((state) => state.exitFullscreen);
  const spacerDragRef = useRef<{ startX: number; startY: number } | null>(null);
  const mac = usesMacTrafficLights();

  const onSpacerMouseDown = useCallback((e: ReactMouseEvent) => {
    spacerDragRef.current = { startX: e.clientX, startY: e.clientY };
  }, []);

  useEffect(() => {
    if (!showWinControls) return;
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
  }, [showWinControls]);

  const handleDoubleClick = async (event: React.MouseEvent) => {
    if (!showWinControls) return;
    const target = event.target as HTMLElement;
    if (target.closest(".win-controls") || target.closest(".workspace-bottom-titlebar-btn")) {
      return;
    }
    const win = getCurrentWindow();
    if (await win.isFullscreen()) {
      await win.setFullscreen(false);
    } else {
      await win.toggleMaximize();
    }
  };

  const exitFullscreenBtn = (
    <button
      type="button"
      className="workspace-bottom-titlebar-btn workspace-bottom-titlebar-btn--exit-fullscreen"
      title={t("shell.workspacePanel.exitFullscreen")}
      aria-label={t("shell.workspacePanel.exitFullscreen")}
      onClick={exitFullscreen}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        width="14"
        height="14"
        aria-hidden
      >
        <path d="M4 14H9v5" />
        <path d="M20 10h-5V5" />
        <path d="M14 10l7-7" />
        <path d="M3 21l7-7" />
      </svg>
    </button>
  );

  return (
    <div
      className={`workspace-bottom-titlebar${showWinControls ? " workspace-bottom-titlebar--fullscreen" : ""}${mac && showWinControls ? " workspace-bottom-titlebar--mac" : ""}`}
      onDoubleClick={handleDoubleClick}
    >
      {mac && showWinControls ? <WinControls enableSnapLayout /> : null}

      <span className="workspace-bottom-titlebar-label" data-tauri-drag-region>
        {workspaceName}
      </span>

      {showWinControls && (
        <div className="workspace-bottom-titlebar-spacer" onMouseDown={onSpacerMouseDown} />
      )}

      <div className="workspace-bottom-titlebar-actions" data-tauri-drag-region="false">
        {showWinControls ? (
          <>
            {exitFullscreenBtn}
            {!mac ? <WinControls enableSnapLayout /> : null}
          </>
        ) : (
          <button
            type="button"
            className="workspace-bottom-titlebar-btn"
            title={t("shell.workspacePanel.fullscreen")}
            aria-label={t("shell.workspacePanel.fullscreen")}
            onClick={enterFullscreen}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14" aria-hidden>
              <path d="M8 3H5a2 2 0 00-2 2v3" />
              <path d="M16 3h3a2 2 0 012 2v3" />
              <path d="M8 21H5a2 2 0 01-2-2v-3" />
              <path d="M16 21h3a2 2 0 002-2v-3" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
