import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef } from "react";

const DRAG_THRESHOLD_PX = 3;

/** 在 CSS app-region 不可靠时，通过鼠标拖动触发 Tauri 窗口移动（与 Topbar spacer 一致） */
export function useWindowDragOnMouseDown() {
  const dragRef = useRef<{ startX: number; startY: number } | null>(null);

  const onMouseDown = useCallback((event: React.MouseEvent) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, input, textarea, select, a, label, .scoped-search-bar, .window-drag-surface--interactive")) {
      return;
    }
    dragRef.current = { startX: event.clientX, startY: event.clientY };
  }, []);

  useEffect(() => {
    const onMouseMove = (event: MouseEvent) => {
      const start = dragRef.current;
      if (!start) return;
      if (
        Math.abs(event.clientX - start.startX) > DRAG_THRESHOLD_PX ||
        Math.abs(event.clientY - start.startY) > DRAG_THRESHOLD_PX
      ) {
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

  return onMouseDown;
}
