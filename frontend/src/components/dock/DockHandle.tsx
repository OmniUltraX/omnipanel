import type { PointerEvent as ReactPointerEvent } from "react";
import { Separator } from "react-resizable-panels";

interface DockHandleProps {
  direction?: "horizontal" | "vertical";
  className?: string;
  /** 用户按下分隔条时触发；勿调用 preventDefault，否则会阻断库的 document 级拖拽监听 */
  onPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
}

export function DockHandle({ direction = "horizontal", className, onPointerDown }: DockHandleProps) {
  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    onPointerDown?.(event);
  };

  return (
    <Separator
      className={`dock-handle dock-handle--${direction}${className ? ` ${className}` : ""}`}
      onPointerDown={onPointerDown ? handlePointerDown : undefined}
    >
      <div className="dock-handle-inner" aria-hidden />
    </Separator>
  );
}
