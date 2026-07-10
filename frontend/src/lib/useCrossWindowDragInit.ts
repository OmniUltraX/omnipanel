import { useEffect } from "react";
import { initCrossWindowDockTransfer } from "./crossWindowDockTransfer";
import { initModuleToWorkspaceDragBridge } from "./moduleToWorkspaceDragBridge";
import { initCrossWindowDragVisual } from "./crossWindowDragVisual";
import { isCrossWindowDragRuntime } from "./crossWindowDragEnabled";
import { installDockviewPointerDragSafety } from "./dockviewPointerDrag";

/**
 * Tauri 下始终初始化跨窗拖拽桥接（document 监听懒挂载，单窗几乎零开销）。
 * 不可按启动时窗口数门控：用户后弹出工作区窗时桥接须已就绪。
 */
export function useCrossWindowDragInit(): void {
  useEffect(() => {
    if (!isCrossWindowDragRuntime()) return;

    const cleanups: Array<() => void> = [];
    try {
      cleanups.push(installDockviewPointerDragSafety());
      cleanups.push(initCrossWindowDockTransfer());
      cleanups.push(initModuleToWorkspaceDragBridge());
      cleanups.push(initCrossWindowDragVisual());
    } catch (e) {
      console.warn("[crossWindow] init failed", e);
    }

    return () => {
      for (const fn of cleanups) fn();
    };
  }, []);
}
