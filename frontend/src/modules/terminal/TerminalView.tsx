import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { useTerminal } from "../../hooks/useTerminal";
import {
  findTerminalPane,
  useTerminalStore,
} from "../../stores/terminalStore";
import type { WorkspaceResource } from "../../lib/resourceRegistry";
import {
  getMockCommandOutput,
  getPromptPrefix,
  seedMockTerminal,
} from "./mockTerminal";

const isTauriRuntime =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export type TerminalViewProps = {
  sessionId: string;
  resource: WorkspaceResource | null;
  startup: string[];
  active: boolean;
  onSenderChange: (
    sessionId: string,
    sender: ((cmd: string) => void) | null,
  ) => void;
};

export function TerminalView({
  sessionId,
  resource,
  startup,
  active,
  onSenderChange,
}: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const sendRef = useRef<((cmd: string) => void) | null>(null);
  const setStatus = useTerminalStore((state) => state.setStatus);

  useTerminal(
    sessionId,
    containerRef,
    undefined,
    undefined,
    undefined,
    !isTauriRuntime,
    {
      inputMode: "external",
      sendRef,
      active,
    },
  );

  const paneStatus = useTerminalStore((state) => {
    const pane = findTerminalPane(sessionId);
    if (pane) return pane.status;
    return state.tabs
      .flatMap((tab) => tab.panes)
      .find((item) => item.id === sessionId)?.status;
  });

  useEffect(() => {
    if (!isTauriRuntime) return;
    if (!active) {
      onSenderChange(sessionId, null);
      return;
    }
    onSenderChange(sessionId, sendRef.current);
    return () => {
      onSenderChange(sessionId, null);
    };
  }, [active, onSenderChange, paneStatus, sessionId]);

  useEffect(() => {
    if (isTauriRuntime) return;
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily:
        '"Cascadia Code", "Fira Code", Menlo, Consolas, monospace',
      theme: {
        background: "#1a1717",
        foreground: "#fdfcfc",
        cursor: "#fdfcfc",
        selectionBackground: "#007aff30",
      },
      scrollback: 5000,
      allowTransparency: false,
    });

    term.open(container);
    term.attachCustomKeyEventHandler(() => false);
    termRef.current = term;
    seedMockTerminal(term, resource, startup);
    setStatus(sessionId, "connected");
    onSenderChange(sessionId, (cmd: string) => {
      const prompt = getPromptPrefix(resource);
      const resourceName = resource?.name ?? "omnipanel";
      term.writeln("");
      term.writeln(`\x1b[32m${prompt}\x1b[0m ${cmd}`);
      getMockCommandOutput(cmd, resourceName).forEach((line) => term.writeln(line));
      term.writeln("");
      term.write(`\x1b[32m${prompt}\x1b[0m `);
    });

    return () => {
      onSenderChange(sessionId, null);
      setStatus(sessionId, "disconnected");
      term.dispose();
      termRef.current = null;
    };
  }, [onSenderChange, resource, sessionId, setStatus, startup]);

  return <div ref={containerRef} className="term-xterm-wrap" />;
}
