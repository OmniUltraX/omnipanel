import { useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { MODULE_PATHS } from "../../lib/paths";
import { useBottomPanelStore } from "../../stores/bottomPanelStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";

const DRAG_START_THRESHOLD_PX = 8;

/**
 * 工程全屏顶栏下方的拖拽把手：一旦开始向下拖拽，立即进入半屏并回到最后操作界面。
 */
export function WorkspaceFullscreenDragHandle() {
  const navigate = useNavigate();
  const activePath = useWorkspaceStore((s) => s.activePath);
  const dragging = useRef(false);
  const exited = useRef(false);
  const startY = useRef(0);
  const moveRef = useRef<((event: PointerEvent) => void) | null>(null);
  const upRef = useRef<(() => void) | null>(null);

  const cleanupListeners = useCallback(() => {
    if (moveRef.current) {
      window.removeEventListener("pointermove", moveRef.current);
      moveRef.current = null;
    }
    if (upRef.current) {
      window.removeEventListener("pointerup", upRef.current);
      window.removeEventListener("pointercancel", upRef.current);
      upRef.current = null;
    }
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    dragging.current = false;
  }, []);

  const exitToHalf = useCallback(() => {
    if (exited.current) return;
    exited.current = true;
    const path =
      activePath && activePath !== "/" ? activePath : MODULE_PATHS.terminal;
    useBottomPanelStore.getState().requestDeferExitFullscreen(path, "drag-half");
    navigate(path);
  }, [activePath, navigate]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      dragging.current = true;
      exited.current = false;
      startY.current = event.clientY;
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";

      const onMove = (ev: PointerEvent) => {
        if (!dragging.current || exited.current) return;
        const delta = ev.clientY - startY.current;
        if (delta >= DRAG_START_THRESHOLD_PX) {
          exitToHalf();
        }
      };
      const onUp = () => {
        cleanupListeners();
      };

      moveRef.current = onMove;
      upRef.current = onUp;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
      event.preventDefault();
    },
    [cleanupListeners, exitToHalf],
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
