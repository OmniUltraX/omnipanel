import { useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useBottomPanelStore } from "../../stores/bottomPanelStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { defaultHeightForMode } from "../../lib/workspaceMode";

const DRAG_THRESHOLD_PX = 36;

/**
 * 工程全屏顶栏下方的拖拽把手：向下拖拽退出全屏并恢复功能页与非全屏高度形态。
 */
export function WorkspaceFullscreenDragHandle() {
  const navigate = useNavigate();
  const activePath = useWorkspaceStore((s) => s.activePath);
  const leaveFullscreenByDrag = useBottomPanelStore((s) => s.leaveFullscreenByDrag);
  const dragging = useRef(false);
  const startY = useRef(0);
  const maxDelta = useRef(0);
  const moveRef = useRef<((event: PointerEvent) => void) | null>(null);
  const upRef = useRef<(() => void) | null>(null);

  const cleanupListeners = useCallback(() => {
    if (moveRef.current) {
      window.removeEventListener("pointermove", moveRef.current);
      moveRef.current = null;
    }
    if (upRef.current) {
      window.removeEventListener("pointerup", upRef.current);
      upRef.current = null;
    }
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    dragging.current = false;
  }, []);

  const finishDrag = useCallback(() => {
    const delta = maxDelta.current;
    cleanupListeners();
    if (delta < DRAG_THRESHOLD_PX) return;

    leaveFullscreenByDrag(defaultHeightForMode("half"));
    const path = activePath && activePath !== "/" ? activePath : "/terminal";
    navigate(path);
  }, [activePath, cleanupListeners, leaveFullscreenByDrag, navigate]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      dragging.current = true;
      startY.current = event.clientY;
      maxDelta.current = 0;
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";

      const onMove = (ev: PointerEvent) => {
        if (!dragging.current) return;
        maxDelta.current = Math.max(maxDelta.current, ev.clientY - startY.current);
      };
      const onUp = () => {
        if (!dragging.current) return;
        finishDrag();
      };

      moveRef.current = onMove;
      upRef.current = onUp;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      event.preventDefault();
    },
    [finishDrag],
  );

  return (
    <div
      className="workspace-fullscreen-drag-handle"
      role="separator"
      aria-orientation="horizontal"
      aria-label="向下拖拽以退出全屏工作区"
      onPointerDown={onPointerDown}
    >
      <span className="workspace-fullscreen-drag-handle__grip" aria-hidden />
    </div>
  );
}
