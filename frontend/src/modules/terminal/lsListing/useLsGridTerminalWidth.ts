import { useLayoutEffect, useRef, useState } from "react";
import {
  LS_GRID_TERMINAL_WIDTH_FALLBACK,
  pxToTerminalColumns,
} from "./layoutLsGrid";

function measureContainerWidthCh(element: HTMLElement): number | null {
  let px = element.clientWidth;
  if (px < 8 && element.parentElement) {
    px = element.parentElement.clientWidth;
  }
  if (px < 8) return null;
  return pxToTerminalColumns(element, px);
}

/** 监听列表容器宽度，换算为终端字符列数（首帧 layout 前测量，避免 grid 列数闪烁） */
export function useLsGridTerminalWidth(enabled: boolean) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [widthCh, setWidthCh] = useState(LS_GRID_TERMINAL_WIDTH_FALLBACK);
  const [isMeasured, setIsMeasured] = useState(false);

  useLayoutEffect(() => {
    if (!enabled) {
      setIsMeasured(false);
      return;
    }
    const element = containerRef.current;
    if (!element) return;

    const update = () => {
      const next = measureContainerWidthCh(element);
      if (next == null) return;
      setWidthCh((prev) => (prev === next ? prev : next));
      setIsMeasured(true);
    };

    update();
    const raf = requestAnimationFrame(() => update());
    const observer = new ResizeObserver(update);
    observer.observe(element);
    const parent = element.parentElement;
    if (parent) observer.observe(parent);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [enabled]);

  return { containerRef, widthCh, isMeasured };
}
