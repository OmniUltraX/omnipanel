import { useCallback, type PointerEvent as ReactPointerEvent } from "react";
import { useTerminalUiStore } from "./terminalUiStore";
import {
  clampAiDockHeight,
  DEFAULT_AI_DOCK_HEIGHT,
} from "./terminalAiDock";

type AiDockResizeHandleProps = {
  sessionId: string;
};

export function AiDockResizeHandle({ sessionId }: AiDockResizeHandleProps) {
  const dockHeight = useTerminalUiStore(
    (state) => state.aiDockHeights[sessionId] ?? DEFAULT_AI_DOCK_HEIGHT,
  );
  const setAiDockHeight = useTerminalUiStore((state) => state.setAiDockHeight);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startY = event.clientY;
      const startHeight = dockHeight;
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);

      const onMove = (moveEvent: globalThis.PointerEvent) => {
        const next = clampAiDockHeight(startHeight + (moveEvent.clientY - startY));
        setAiDockHeight(sessionId, next);
      };

      const onUp = (upEvent: globalThis.PointerEvent) => {
        handle.releasePointerCapture(upEvent.pointerId);
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
      };

      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onUp);
    },
    [dockHeight, sessionId, setAiDockHeight],
  );

  return (
    <div
      className="term-warp-ai-dock__resize"
      role="separator"
      aria-orientation="horizontal"
      aria-label="调整 AI 面板最大高度"
      onPointerDown={onPointerDown}
    />
  );
}
