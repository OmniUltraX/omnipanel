import { useCallback, useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AiChromeButton } from "../../shell/AiChromeButton";
import { WinControls } from "../../shell/WinControls";

/**
 * AI Dock 顶栏：与主窗口 tab 栏等高贯通，仅放拖拽区 + 窗口 chrome。
 * 会话标题 / 工具按钮在下一层 toolbar。
 */
export function AiDockChrome() {
  const dragRef = useRef<{ startX: number; startY: number } | null>(null);

  const onDragMouseDown = useCallback((e: React.MouseEvent) => {
    dragRef.current = { startX: e.clientX, startY: e.clientY };
  }, []);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      const s = dragRef.current;
      if (!s) return;
      if (Math.abs(e.clientX - s.startX) > 3 || Math.abs(e.clientY - s.startY) > 3) {
        dragRef.current = null;
        void getCurrentWindow().startDragging();
      }
    };
    const onMouseUp = () => {
      dragRef.current = null;
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
    if (target.closest(".win-controls, .dock-chrome-ai-btn")) return;
    const win = getCurrentWindow();
    if (await win.isFullscreen()) {
      await win.setFullscreen(false);
    } else {
      await win.toggleMaximize();
    }
  };

  return (
    <div className="ai-dock-chrome" onDoubleClick={handleDoubleClick}>
      <div
        className="ai-dock-chrome-drag"
        data-tauri-drag-region
        onMouseDown={onDragMouseDown}
      />
      <div className="ai-dock-chrome-actions">
        <AiChromeButton />
        <WinControls className="ai-dock-win-controls" />
      </div>
    </div>
  );
}
