import { useRef } from "react";
import { useTerminal } from "../../hooks/useTerminal";
import type { SearchAddon } from "@xterm/addon-search";
import type { Terminal } from "@xterm/xterm";
import type { TerminalBlock } from "../../stores/blocksStore";

interface Props {
  sessionId: string;
  active: boolean;
  onTerminalReady?: (terminal: Terminal, searchAddon: SearchAddon) => void;
  onCommand?: (command: string) => void;
  onBlockRightClick?: (block: TerminalBlock, position: { x: number; y: number }) => void;
}

export function TerminalTabContent({ sessionId, active, onTerminalReady, onCommand, onBlockRightClick }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  useTerminal(sessionId, containerRef, onTerminalReady, onCommand, onBlockRightClick);

  return (
    <div
      ref={containerRef}
      style={{
        display: active ? "flex" : "none",
        flex: 1,
        minHeight: 0,
        background: "#1a1717",
      }}
    />
  );
}
