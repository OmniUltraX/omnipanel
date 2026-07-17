import { useCallback, useEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";

/** 侧栏树行根节点固定为 div，统一事件类型避免 strictFunctionTypes 下逆变冲突。 */
export type TreeRowMouseEvent = ReactMouseEvent<HTMLDivElement>;

export type UseTreeClickDelayOptions = {
  onClick?: (event: TreeRowMouseEvent) => void;
  onDoubleClick?: (event: TreeRowMouseEvent) => void;
  delayMs?: number;
  /** 为 false 时不做防抖，直接调用 */
  enabled?: boolean;
  shouldIgnoreClick?: (target: EventTarget | null) => boolean;
};

export function useTreeClickDelay({
  onClick,
  onDoubleClick,
  delayMs = 200,
  enabled = true,
  shouldIgnoreClick,
}: UseTreeClickDelayOptions) {
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    },
    [],
  );

  const onRowClick = useCallback(
    (event: TreeRowMouseEvent) => {
      if (shouldIgnoreClick?.(event.target)) return;
      if (!onClick) return;

      // 同时有单击/双击时延迟单击，避免 dblclick 序列里的 click 抢先执行
      if (enabled && onDoubleClick && delayMs > 0) {
        if (timerRef.current !== null) {
          window.clearTimeout(timerRef.current);
        }
        timerRef.current = window.setTimeout(() => {
          timerRef.current = null;
          onClick(event);
        }, delayMs);
        return;
      }

      onClick(event);
    },
    [delayMs, enabled, onClick, onDoubleClick, shouldIgnoreClick],
  );

  const onRowDoubleClick = useCallback(
    (event: TreeRowMouseEvent) => {
      if (shouldIgnoreClick?.(event.target)) return;

      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }

      if (onDoubleClick) {
        event.preventDefault();
        event.stopPropagation();
        onDoubleClick(event);
        return;
      }

      onClick?.(event);
    },
    [onClick, onDoubleClick, shouldIgnoreClick],
  );

  return { onRowClick, onRowDoubleClick };
}
