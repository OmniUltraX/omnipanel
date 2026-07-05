import { useCallback, useRef, useState } from "react";

export interface DataLoadingProps {
  /** 总步骤数 */
  total: number;
  /** 当前已完成步骤数 */
  current: number;
  /** 进度条下方说明文字（居中） */
  message?: string;
  className?: string;
}

export interface UseDataLoadingResult {
  total: number;
  current: number;
  message?: string;
  /** 重置进度，total 为总步骤数，可选初始说明 */
  reset: (total: number, message?: string) => void;
  /** 动态调整总步骤数（加载过程中获知实际总量时使用） */
  setTotal: (total: number) => void;
  /** 前进一步，delta 默认为 1，可大于 1；可选更新说明文字 */
  advance: (delta?: number, message?: string) => void;
}

export function useDataLoading(): UseDataLoadingResult {
  const [total, setTotalState] = useState(0);
  const [current, setCurrentState] = useState(0);
  const [message, setMessage] = useState<string | undefined>();
  const totalRef = useRef(0);

  totalRef.current = total;

  const reset = useCallback((newTotal: number, initialMessage?: string) => {
    totalRef.current = Math.max(0, newTotal);
    setTotalState(totalRef.current);
    setCurrentState(0);
    setMessage(initialMessage);
  }, []);

  const setTotal = useCallback((newTotal: number) => {
    totalRef.current = Math.max(0, newTotal);
    setTotalState(totalRef.current);
  }, []);

  const advance = useCallback((delta = 1, nextMessage?: string) => {
    setCurrentState((c) => Math.min(totalRef.current, c + Math.max(0, delta)));
    if (nextMessage !== undefined) setMessage(nextMessage);
  }, []);

  return { total, current, message, reset, setTotal, advance };
}

export function DataLoading({ total, current, message, className }: DataLoadingProps) {
  const pct = total > 0 ? Math.min(100, (current / total) * 100) : 0;
  const rootClass = className ? `data-loading ${className}` : "data-loading";

  return (
    <div className={rootClass}>
      <div
        className="data-loading__bar"
        role="progressbar"
        aria-valuenow={current}
        aria-valuemin={0}
        aria-valuemax={total}
      >
        <div className="data-loading__fill" style={{ width: `${pct}%` }} />
      </div>
      {message ? <p className="data-loading__message">{message}</p> : null}
    </div>
  );
}
