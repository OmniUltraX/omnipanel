import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef } from "react";
import { useAiDockOpen } from "../../lib/ai/useAiDockOpen";
import { WinControls } from "../shell/WinControls";
import { AiChromeButton } from "../shell/AiChromeButton";
import { ModuleChromeSettingsButton } from "../shell/ModuleChromeSettingsButton";
import { usesMacTrafficLights } from "../../lib/platform";
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
    if (target.closest(".win-controls, .dock-chrome-ai-btn, .dock-chrome-settings-btn")) return;
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
  // macOS 红绿灯改由 Sidebar（主壳）或 dock 前缀区（独立窗）托管，右侧不再重复
  const mac = usesMacTrafficLights();
  const showWinControls = showControls && !mac;

  if (!showDrag && !showWinControls && !leftActions && !(showControls && mac)) {
    return null;
  }

  return (
    <div
      className={[
        "dock-window-title-actions",
        "drag-ignore",
        showWinControls && !showDrag ? "dock-window-title-actions--controls-only" : "",
        aiDockOpen ? "dock-window-title-actions--ai-dock-open" : "",
        mac ? "dock-window-title-actions--mac" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-tauri-drag-region="false"
      onDoubleClick={handleDoubleClick}
    >
      {showDrag ? <DockWindowDragSpacer /> : null}
      {leftActions || showControls ? (
        <div className="dock-window-chrome-left-actions">
          {leftActions}
          {showControls ? (
            <>
              <AiChromeButton />
              <ModuleChromeSettingsButton />
            </>
          ) : null}
        </div>
      ) : null}
      {/* 主窗 / 模块独立窗可见的窗口三键；挂 Snap Layout overlay（仅 Windows） */}
      {showWinControls ? <WinControls enableSnapLayout /> : null}
    </div>
  );
}
