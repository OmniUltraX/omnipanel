import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { Separator } from "react-resizable-panels";

interface DockHandleProps {
  direction?: "horizontal" | "vertical";
  className?: string;
  /** 用户按下分隔条时触发；勿调用 preventDefault，否则会阻断库的 document 级拖拽监听 */
  onPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  /**
   * 捕获阶段的键盘事件。必须早于库在分隔条上的 keydown，
   * 才能把方向键调宽记成用户操作。
   */
  onKeyDownCapture?: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
}

export function DockHandle({
  direction = "horizontal",
  className,
  onPointerDown,
  onKeyDownCapture,
}: DockHandleProps) {
  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    onPointerDown?.(event);
  };

  return (
    <Separator
      className={`dock-handle dock-handle--${direction}${className ? ` ${className}` : ""}`}
      onPointerDown={onPointerDown ? handlePointerDown : undefined}
      onKeyDownCapture={onKeyDownCapture}
    >
      <div className="dock-handle-inner" aria-hidden />
    </Separator>
  );
}
