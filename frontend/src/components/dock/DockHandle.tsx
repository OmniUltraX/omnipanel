import type { PointerEvent as ReactPointerEvent } from "react";
import { Separator } from "react-resizable-panels";

interface DockHandleProps {
  direction?: "horizontal" | "vertical";
  onPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
}

export function DockHandle({ direction = "horizontal", onPointerDown }: DockHandleProps) {
  return (
    <Separator
      className={`dock-handle dock-handle--${direction}`}
      onPointerDown={onPointerDown}
    >
      <div className="dock-handle-inner" />
    </Separator>
  );
}
