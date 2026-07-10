import { useCallback, useEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";

export type UseTreeClickDelayOptions = {
  onClick?: (event: ReactMouseEvent<HTMLElement>) => void;
  onDoubleClick?: (event: ReactMouseEvent<HTMLElement>) => void;
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
    (event: ReactMouseEvent<HTMLElement>) => {
      if (shouldIgnoreClick?.(event.target)) return;

      if (!enabled || !onClick) return;

      if (onDoubleClick && delayMs > 0) {
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
    (event: ReactMouseEvent<HTMLElement>) => {
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
