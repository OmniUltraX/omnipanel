import { useCallback, useEffect, useRef, useState } from "react";
import {
  visibleFloatContributions,
  type FloatContribution,
} from "../../lib/menuContributions";
import { usePluginOverlayStore } from "../../stores/pluginOverlayStore";

type FloatState = {
  x: number;
  y: number;
  items: FloatContribution[];
};

/**
 * 选中悬浮按钮层：当存在 opt-in（`float` 非空）的选中动作且有非空选区时，
 * 在鼠标附近浮现 1 字图标按钮（如"译"）。无插件 opt-in 时完全不可见，
 * 日常选中不受打扰。点击按捕获到的文本执行，不依赖点击时重读选区
 * （点击本身会收起 DOM 选区）。
 */
export function SelectionFloatLayer() {
  const [state, setState] = useState<FloatState | null>(null);
  const lastMouse = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const dismissedFor = useRef<string | null>(null);
  // overlay 打开（焦点已迁移、选区多半收起）时不浮现，避免叠在对话框上
  // 或用终端残留选区错误弹出。
  const overlayOpen = usePluginOverlayStore((s) => s.entries.length > 0);

  const refresh = useCallback(() => {
    if (overlayOpen) {
      setState(null);
      return;
    }
    const items = visibleFloatContributions();
    const text = items[0]?.selectionText ?? "";
    if (!text) {
      // 选区清空 = 新一轮开始：重置已行动标记，同段文本重选可再浮现
      dismissedFor.current = null;
      setState(null);
      return;
    }
    // 同一段文本行动过一次后不再打扰，直到选区变化
    if (dismissedFor.current === text) {
      setState(null);
      return;
    }
    dismissedFor.current = null;
    const { x, y } = lastMouse.current;
    setState({
      x: Math.min(Math.max(8, x + 14), window.innerWidth - 160),
      y: Math.min(Math.max(8, y + 16), window.innerHeight - 60),
      items,
    });
  }, [overlayOpen]);

  useEffect(() => {
    const onMouseUp = (ev: MouseEvent) => {
      lastMouse.current = { x: ev.clientX, y: ev.clientY };
      // 让选区先落定再读
      window.setTimeout(refresh, 0);
    };
    const onSelectionChange = () => {
      refresh();
    };
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        dismissedFor.current = null;
        setState(null);
      }
    };
    const onScroll = () => setState(null);
    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [refresh]);

  if (!state) return null;

  const runItem = (item: FloatContribution) => {
    dismissedFor.current = item.selectionText;
    setState(null);
    try {
      const ret = item.onClick({ selectionText: item.selectionText });
      if (ret && typeof ret.catch === "function") {
        ret.catch((err) => console.error(`[selection-float] ${item.id} 执行失败`, err));
      }
    } catch (err) {
      console.error(`[selection-float] ${item.id} 执行失败`, err);
    }
  };

  return (
    <div
      className="selection-float-layer"
      style={{ left: state.x, top: state.y }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {state.items.slice(0, 3).map((item) => (
        <button
          key={`${item.pluginId}:${item.id}`}
          type="button"
          className="selection-float-btn"
          title={item.label}
          aria-label={item.label}
          onClick={() => runItem(item)}
        >
          {item.float?.icon || item.label.slice(0, 1)}
        </button>
      ))}
    </div>
  );
}
