import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useCrossWindowDragVisualStore } from "../../lib/crossWindowDragVisual";
import { screenPointToClient } from "../../lib/crossWindowDragUtils";

/**
 * 跨窗拖拽视觉层：目标窗内 ghost tab + 落点高亮（仿 dockview 原生效果）。
 */
export function CrossWindowDragVisualLayer() {
  const active = useCrossWindowDragVisualStore((s) => s.active);
  const label = useCrossWindowDragVisualStore((s) => s.label);
  const screenX = useCrossWindowDragVisualStore((s) => s.screenX);
  const screenY = useCrossWindowDragVisualStore((s) => s.screenY);
  const showGhost = useCrossWindowDragVisualStore((s) => s.showGhost);
  const dropPreview = useCrossWindowDragVisualStore((s) => s.dropPreview);

  useEffect(() => {
    if (!active) {
      document.body.classList.remove("omnipanel-cross-window-drag-visual-active");
      return;
    }
    document.body.classList.add("omnipanel-cross-window-drag-visual-active");
    return () => {
      document.body.classList.remove("omnipanel-cross-window-drag-visual-active");
    };
  }, [active]);

  if (!active || typeof document === "undefined") {
    return null;
  }

  const { clientX, clientY } = screenPointToClient(screenX, screenY);
  const hasPointer = screenX !== 0 || screenY !== 0;

  return createPortal(
    <div className="cross-window-drag-visual-root" aria-hidden>
      {dropPreview ? (
        <div
          className={`cross-window-drag-drop-preview cross-window-drag-drop-preview--${dropPreview.kind}`}
          style={{
            left: dropPreview.left,
            top: dropPreview.top,
            width: dropPreview.width,
            height: dropPreview.height,
          }}
        />
      ) : null}
      {showGhost && hasPointer ? (
        <div
          className="cross-window-drag-ghost"
          style={{
            left: clientX,
            top: clientY,
          }}
        >
          <span className="cross-window-drag-ghost__label">{label}</span>
          <span className="cross-window-drag-ghost__close" aria-hidden>
            ×
          </span>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
