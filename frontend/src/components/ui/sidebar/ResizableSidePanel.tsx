import { useCallback, useRef, type ReactNode } from "react";

interface ResizableSidePanelProps {
  open: boolean;
  width: number;
  onWidthChange: (width: number) => void;
  minWidth?: number;
  maxWidth?: number;
  defaultWidth?: number;
  side?: "left" | "right";
  children: ReactNode;
}

const HANDLE_WIDTH = 4;
const HIT_AREA = 6;

export function ResizableSidePanel({
  open,
  width,
  onWidthChange,
  minWidth = 180,
  maxWidth = 480,
  side = "right",
  children,
}: ResizableSidePanelProps) {
  const dragging = useRef(false);
  const startX = useRef(0);
  const startW = useRef(0);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      dragging.current = true;
      startX.current = e.clientX;
      startW.current = width;
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [width],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging.current) return;
      const dx = e.clientX - startX.current;
      const newWidth = side === "right"
        ? startW.current - dx
        : startW.current + dx;
      onWidthChange(Math.min(maxWidth, Math.max(minWidth, Math.round(newWidth))));
    },
    [side, minWidth, maxWidth, onWidthChange],
  );

  const handlePointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  return (
    <div
      className="relative flex shrink-0"
      style={{ width: open ? width : 0, overflow: open ? undefined : "hidden" }}
    >
      <div
        className="absolute inset-y-0 z-10 cursor-col-resize"
        style={{
          [side === "right" ? "left" : "right"]: -(HIT_AREA / 2),
          width: HIT_AREA,
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <div
          className="bg-border/40 hover:bg-border/80 absolute inset-y-0 top-2 bottom-2 rounded-full transition-colors"
          style={{
            [side === "right" ? "left" : "right"]: (HIT_AREA - HANDLE_WIDTH) / 2,
            width: HANDLE_WIDTH,
          }}
        />
      </div>
      <div className="min-w-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}
