import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useBottomPanelStore } from "../../stores/bottomPanelStore";
import { useI18n } from "../../i18n";

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
  const [isMaximized, setIsMaximized] = useState(false);
  const spacerDragRef = useRef<{ startX: number; startY: number } | null>(null);

  const handleMinimize = async () => {
    await getCurrentWindow().minimize();
  };

  const handleMaximize = async () => {
    await getCurrentWindow().toggleMaximize();
  };

  const handleClose = async () => {
    await getCurrentWindow().close();
  };

  const onSpacerMouseDown = useCallback((e: React.MouseEvent) => {
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

  useEffect(() => {
    if (!showWinControls) return;
    const win = getCurrentWindow();
    const update = async () => setIsMaximized(await win.isMaximized());
    update();
    let unlisten: (() => void) | undefined;
    (async () => {
      unlisten = await win.onResized(update);
    })();
    return () => unlisten?.();
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

  return (
    <div
      className={`workspace-bottom-titlebar${showWinControls ? " workspace-bottom-titlebar--fullscreen" : ""}`}
      onDoubleClick={handleDoubleClick}
    >
      <span className="workspace-bottom-titlebar-label" data-tauri-drag-region>
        {workspaceName}
      </span>

      {showWinControls && (
        <div className="workspace-bottom-titlebar-spacer" onMouseDown={onSpacerMouseDown} />
      )}

      <div className="workspace-bottom-titlebar-actions" data-tauri-drag-region="false">
        {showWinControls ? (
          <div className="win-controls">
            <button
              className="win-btn minimize"
              title={t("shell.topbar.minimize")}
              onClick={handleMinimize}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M0 5h10" stroke="currentColor" strokeWidth="1.2" />
              </svg>
            </button>
            <button
              className="win-btn maximize"
              title={isMaximized ? t("shell.topbar.restore") : t("shell.topbar.maximize")}
              onClick={handleMaximize}
            >
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
