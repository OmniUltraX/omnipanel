import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef } from "react";
import { useAiDockOpen } from "../../lib/ai/useAiDockOpen";
import { WinControls } from "../shell/WinControls";
import { AiChromeButton } from "../shell/AiChromeButton";
import type { DockWindowChromeActionsProps } from "./dockWindowChromeActions";

export type { DockWindowChromeActionsProps, DockWindowChromeMode } from "./dockWindowChromeActions";

function DockWindowDragSpacer() {
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

  return (
    <div
      className="dock-window-drag-spacer"
      data-tauri-drag-region
      onMouseDown={onSpacerMouseDown}
    />
  );
}

/** 嵌入 dockview tab 栏右侧：按布局挂载拖拽区与/或窗口控制按钮 */
export function DockWindowChromeActions({ mode, leftActions }: DockWindowChromeActionsProps) {
  // AI Dock 打开时 tab 栏向右贯通到窗口边缘，窗口三键仍挂在 tab 栏最右侧
  const aiDockOpen = useAiDockOpen();

  const handleDoubleClick = async (event: React.MouseEvent) => {
    if (mode === "controls") return;
    const target = event.target as HTMLElement;
    if (target.closest(".win-controls")) return;
    if (target.closest(".dv-tab, .dv-default-tab, .dock-tab-header-root")) return;
    const win = getCurrentWindow();
    if (await win.isFullscreen()) {
      await win.setFullscreen(false);
    } else {
      await win.toggleMaximize();
    }
  };

  const showDrag = mode === "drag" || mode === "both";
  const showControls = mode === "controls" || mode === "both";

  if (!showDrag && !showControls && !leftActions) {
    return null;
  }

  return (
    <div
      className={`dock-window-title-actions drag-ignore${showControls && !showDrag ? " dock-window-title-actions--controls-only" : ""}${aiDockOpen ? " dock-window-title-actions--ai-dock-open" : ""}`}
      data-tauri-drag-region="false"
      onDoubleClick={handleDoubleClick}
    >
      {showDrag ? <DockWindowDragSpacer /> : null}
      {leftActions || showControls ? (
        <div className="dock-window-chrome-left-actions">
          {leftActions}
          {showControls ? <AiChromeButton /> : null}
        </div>
      ) : null}
      {showControls ? <WinControls /> : null}
    </div>
  );
}
