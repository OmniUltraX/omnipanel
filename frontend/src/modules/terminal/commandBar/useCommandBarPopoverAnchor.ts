import { useCallback, useEffect, useState, type RefObject } from "react";

export type PopoverAnchorRect = {
  left: number;
  top: number;
  width: number;
};

/** 命令栏补全/历史弹出层锚点（fixed 定位，避开 overflow 裁切） */
export function useCommandBarPopoverAnchor(
  anchorRef: RefObject<HTMLElement | null>,
  visible: boolean,
): PopoverAnchorRect | null {
  const [rect, setRect] = useState<PopoverAnchorRect | null>(null);

  const sync = useCallback(() => {
    const el = anchorRef.current;
    if (!el) {
      setRect(null);
      return;
    }
    const bounds = el.getBoundingClientRect();
    setRect({
      left: bounds.left,
      top: bounds.top,
      width: bounds.width,
    });
  }, [anchorRef]);

  useEffect(() => {
    if (!visible) {
      setRect(null);
      return;
    }
    sync();
    window.addEventListener("resize", sync);
    window.addEventListener("scroll", sync, true);
    return () => {
      window.removeEventListener("resize", sync);
      window.removeEventListener("scroll", sync, true);
    };
  }, [visible, sync]);

  return rect;
}

export function popoverFixedStyle(
  anchor: PopoverAnchorRect,
  maxHeight: number,
): { left: number; width: number; bottom: number; maxHeight: number } {
  const gap = 4;
  return {
    left: anchor.left,
    width: anchor.width,
    bottom: window.innerHeight - anchor.top + gap,
    maxHeight,
  };
}
