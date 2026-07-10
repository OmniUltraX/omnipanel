import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import { useCrossWindowDragVisualStore } from "../../lib/crossWindowDragVisual";
import { screenPointToClient } from "../../lib/crossWindowDragUtils";

/**
 * 跨窗拖拽视觉层：目标窗内 ghost tab + 落点高亮（仿 dockview 原生效果）。
 */
export function CrossWindowDragVisualLayer() {
  const { active, label, screenX, screenY, showGhost, dropPreview } =
    useCrossWindowDragVisualStore(
      useShallow((s) => ({
        active: s.active,
        label: s.label,
        screenX: s.screenX,
        screenY: s.screenY,
        showGhost: s.showGhost,
        dropPreview: s.dropPreview,
      })),
    );

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
  // 远程首包可能暂无坐标；仍渲染 ghost，pointermove/MOVE 会立刻纠正位置
  const showGhostAtPointer = showGhost;

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
      {showGhostAtPointer ? (
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
