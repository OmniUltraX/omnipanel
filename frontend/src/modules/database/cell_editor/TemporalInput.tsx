import {
  useEffect,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type Ref,
} from "react";

export type TemporalInputType = "date" | "datetime-local" | "time";

export interface TemporalInputProps {
  type: TemporalInputType;
  value: string;
  onChange: (value: string) => void;
  className?: string;
  wrapperClassName?: string;
  autoFocus?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  onBlur?: () => void;
  onMouseDown?: (event: MouseEvent) => void;
  onClick?: (event: MouseEvent) => void;
  onDoubleClick?: (event: MouseEvent) => void;
}

/** 将 DB / 文本格式收敛为原生 input 可接受的值 */
export function toNativeTemporalValue(type: TemporalInputType, raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  if (type === "date") {
    const m = trimmed.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (!m) return trimmed.slice(0, 10);
    return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  }

  if (type === "time") {
    const m = trimmed.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (!m) return trimmed.slice(0, 8);
    return `${m[1].padStart(2, "0")}:${m[2]}:${m[3] ?? "00"}`;
  }

  const m = trimmed.match(
    /(\d{4})[-/](\d{1,2})[-/](\d{1,2})[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?/,
  );
  if (m) {
    return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}T${m[4].padStart(2, "0")}:${m[5]}:${m[6] ?? "00"}`;
  }
  const d = trimmed.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (d) {
    return `${d[1]}-${d[2].padStart(2, "0")}-${d[3].padStart(2, "0")}T00:00:00`;
  }
  return trimmed.replace(" ", "T");
}

/**
 * 与二进制日志筛选一致：原生 date / datetime-local / time，
 * 保留浏览器分段展示与日历指示器。
 */
export function TemporalInput({
  type,
  value,
  onChange,
  className,
  wrapperClassName,
  autoFocus = false,
  inputRef,
  onKeyDown,
  onBlur,
  onMouseDown,
  onClick,
  onDoubleClick,
}: TemporalInputProps) {
  const localRef = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? localRef;
  const nativeValue = toNativeTemporalValue(type, value);

  useEffect(() => {
    if (!autoFocus) return;
    const el = typeof ref === "function" ? null : ref?.current;
    el?.focus();
  }, [autoFocus, ref]);

  return (
    <input
      ref={ref}
      type={type}
      className={[
        "db-temporal-native",
        `db-temporal-native--${type === "datetime-local" ? "datetime" : type}`,
        wrapperClassName,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      value={nativeValue}
      step={type === "date" ? undefined : 1}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      onMouseDown={onMouseDown}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    />
  );
}
