import { useRef, useCallback, useState, useEffect } from "react";
import type { PaneLayout } from "../../stores/terminalStore";
import { TerminalTabContent } from "./TerminalTabContent";
import type { TerminalBlock } from "../../stores/blocksStore";
import type { SearchAddon } from "@xterm/addon-search";
import type { Terminal } from "@xterm/xterm";
import type { TerminalInputMode } from "../../hooks/useTerminal";

interface PaneRendererProps {
  layout: PaneLayout;
  activeTabId: string | null;
  suspended?: boolean;
  inputMode?: TerminalInputMode;
  sendRef?: React.RefObject<((cmd: string) => void) | null>;
  onTerminalReady: (tabId: string, terminal: Terminal, searchAddon: SearchAddon) => void;
  onCommand?: (command: string) => void;
  onBlockRightClick?: (block: TerminalBlock, position: { x: number; y: number }) => void;
}

function getLayoutKey(layout: PaneLayout): string {
  if (layout.type === "leaf") return layout.paneId;
  return layout.children.map(getLayoutKey).join("|");
}

export function PaneRenderer({
  layout,
  activeTabId,
  suspended = false,
  inputMode = "interactive",
  sendRef,
  onTerminalReady,
  onCommand,
  onBlockRightClick,
}: PaneRendererProps) {
  if (layout.type === "leaf") {
    return (
      <TerminalTabContent
        sessionId={layout.paneId}
        active={layout.paneId === activeTabId}
        suspended={suspended}
        onTerminalReady={(term, sa) => onTerminalReady(layout.paneId, term, sa)}
        onCommand={onCommand}
        onBlockRightClick={onBlockRightClick}
      />
    );
  }

  const childKeys = layout.children.map(getLayoutKey);

  return (
    <SplitContainer direction={layout.direction} childKeys={childKeys}>
      {layout.children.map((child) => (
        <PaneRenderer
          key={getLayoutKey(child)}
          layout={child}
          activeTabId={activeTabId}
          suspended={suspended}
          inputMode={inputMode}
          sendRef={sendRef}
          onTerminalReady={onTerminalReady}
          onCommand={onCommand}
          onBlockRightClick={onBlockRightClick}
        />
      ))}
    </SplitContainer>
  );
}

interface SplitContainerProps {
  direction: "horizontal" | "vertical";
  children: React.ReactNode[];
  childKeys: string[];
}

function SplitContainer({ direction, children, childKeys }: SplitContainerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [sizes, setSizes] = useState<number[]>(() =>
    children.map(() => 100 / children.length)
  );
  const dragRef = useRef<{ index: number; startPos: number; startSizes: number[] } | null>(null);

  // Reset sizes when children count changes
  useEffect(() => {
    setSizes(children.map(() => 100 / children.length));
  }, [children.length]);

  const handleMouseDown = useCallback(
    (index: number, e: React.MouseEvent) => {
      e.preventDefault();
      const container = containerRef.current;
      if (!container) return;

      const startPos = direction === "horizontal" ? e.clientX : e.clientY;
      dragRef.current = { index, startPos, startSizes: [...sizes] };

      const handleMouseMove = (me: MouseEvent) => {
        if (!dragRef.current || !containerRef.current) return;
        const containerSize =
          direction === "horizontal"
            ? containerRef.current.clientWidth
            : containerRef.current.clientHeight;
        const delta = ((me.clientX - dragRef.current.startPos) / containerSize) * 100;

        setSizes((prev) => {
          const next = [...prev];
          const sum = dragRef.current!.startSizes[index] + dragRef.current!.startSizes[index + 1];
          let left = dragRef.current!.startSizes[index] + delta;
          let right = dragRef.current!.startSizes[index + 1] - delta;
          // Clamp while preserving total
          if (left < 10) { left = 10; right = sum - 10; }
          if (right < 10) { right = 10; left = sum - 10; }
          next[index] = left;
          next[index + 1] = right;
          return next;
        });
      };

      const handleMouseUp = () => {
        dragRef.current = null;
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [direction, sizes]
  );

  const isHorizontal = direction === "horizontal";

  return (
    <div
      ref={containerRef}
      style={{
        display: "flex",
        flexDirection: isHorizontal ? "row" : "column",
        flex: 1,
        minHeight: 0,
        minWidth: 0,
      }}
    >
      {children.map((child, i) => (
        <div key={childKeys[i]} style={{ display: "flex", flex: `${sizes[i]} 1 0%`, minHeight: 0, minWidth: 0, width: "100%" }}>
          {child}
          {i < children.length - 1 && (
            <div
              onMouseDown={(e) => handleMouseDown(i, e)}
              style={{
                width: isHorizontal ? 4 : "100%",
                height: isHorizontal ? "100%" : 4,
                background: "var(--border)",
                cursor: isHorizontal ? "col-resize" : "row-resize",
                flexShrink: 0,
                zIndex: 10,
              }}
            />
          )}
        </div>
      ))}
    </div>
  );
}
