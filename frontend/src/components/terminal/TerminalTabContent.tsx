import { useRef, type RefObject } from "react";
import { useTerminal, type TerminalInputMode } from "../../hooks/useTerminal";
import type { TerminalBlock } from "../../stores/blocksStore";
import type { SearchAddon } from "@xterm/addon-search";
import type { Terminal } from "@xterm/xterm";

interface Props {
  sessionId: string;
  active: boolean;
  suspended?: boolean;
  inputMode?: TerminalInputMode;
  sendRef?: RefObject<((cmd: string) => void) | null>;
  onTerminalReady?: (terminal: Terminal, searchAddon: SearchAddon) => void;
  onCommand?: (command: string) => void;
  onBlockRightClick?: (block: TerminalBlock, position: { x: number; y: number }) => void;
}

export function TerminalTabContent({
  sessionId,
  active,
  suspended = false,
  inputMode = "interactive",
  sendRef,
  onTerminalReady,
  onCommand,
  onBlockRightClick,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useTerminal(
    sessionId,
    containerRef,
    onTerminalReady,
    onCommand,
    onBlockRightClick,
    suspended || !active,
    { inputMode, sendRef, active }
  );

  if (!active) return null;

  return <div ref={containerRef} className="term-xterm-wrap" />;
}
