import { useCallback, useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AiChromeButton } from "../../shell/AiChromeButton";
import { ModuleChromeSettingsButton } from "../../shell/ModuleChromeSettingsButton";
import { WinControls } from "../../shell/WinControls";
import { usesMacTrafficLights } from "../../../lib/platform";

/**
 * AI Dock 顶栏：与主窗口 Tab 栏同行同高，作为右侧延续（拖拽区 + AI 入口 + 窗口三键）。
 * 会话标题 / 工具按钮在下一层 toolbar。
 * macOS 红绿灯由主壳 Sidebar / 独立窗 dock 前缀托管，此处不重复渲染。
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
    if (target.closest(".win-controls, .dock-chrome-ai-btn, .dock-chrome-settings-btn")) return;
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
        <ModuleChromeSettingsButton />
        {!usesMacTrafficLights() ? <WinControls className="ai-dock-win-controls" /> : null}
      </div>
    </div>
  );
}
