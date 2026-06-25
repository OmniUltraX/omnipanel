import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { useTerminal, type TerminalInputMode } from "../../hooks/useTerminal";
import { useModuleSuspended } from "../../lib/moduleVisibility";
import {
  findTerminalPane,
  useTerminalStore,
} from "../../stores/terminalStore";
import { useSettingsStore } from "../../stores/settingsStore";
import type { WorkspaceResource } from "../../lib/resourceRegistry";
import type { TerminalBlock } from "../../stores/blocksStore";
import {
  getMockCommandOutput,
  getPromptPrefix,
  seedMockTerminal,
} from "./mockTerminal";
import { triggerAiDrawerToggle } from "../../hooks/useAiDrawerShortcut";

const isTauriRuntime =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export type TerminalViewProps = {
  sessionId: string;
  resource: WorkspaceResource | null;
  startup: string[];
  active: boolean;
  inputMode?: TerminalInputMode;
  onSenderChange: (
    sessionId: string,
    sender: ((cmd: string) => void) | null,
  ) => void;
  onBlockRightClick?: (block: TerminalBlock, position: { x: number; y: number }) => void;
  /** 自增时强制 useTerminal 重新初始化（用于刷新按钮） */
  reconnectKey?: number;
};

export function TerminalView({
  sessionId,
  resource,
  startup,
  active,
  inputMode = "external",
  onSenderChange,
  onBlockRightClick,
  reconnectKey,
}: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const sendRef = useRef<((cmd: string) => void) | null>(null);
  const setStatus = useTerminalStore((state) => state.setStatus);
  const moduleSuspended = useModuleSuspended();
  const terminalSuspended = !isTauriRuntime || moduleSuspended;

  useTerminal(
    sessionId,
    containerRef,
    undefined,
    undefined,
    onBlockRightClick,
    terminalSuspended,
    {
      inputMode,
      sendRef,
      active: active && !moduleSuspended,
      reconnectKey,
    },
  );

  const paneStatus = useTerminalStore((state) => {
    const pane = findTerminalPane(sessionId);
    if (pane) return pane.status;
    return state.tabs.find((item) => item.id === sessionId)?.status;
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

    const settings = useSettingsStore.getState();
    const term = new Terminal({
      cursorBlink: settings.terminalCursorBlink,
      cursorStyle: settings.terminalCursorStyle,
      fontSize: settings.terminalFontSize,
      fontFamily: `"${settings.terminalFontFamily}", "Cascadia Code", "Fira Code", Menlo, Consolas, monospace`,
      lineHeight: settings.terminalLineHeight,
      theme: {
        background: "#1a1717",
        foreground: "#fdfcfc",
        cursor: "#fdfcfc",
        selectionBackground: "#007aff30",
      },
      scrollback: settings.terminalScrollback,
      allowTransparency: false,
    });
    (term.options as typeof term.options & { copyOnSelect?: boolean }).copyOnSelect =
      settings.terminalCopyOnSelect;

    term.open(container);
    term.attachCustomKeyEventHandler((e) => triggerAiDrawerToggle(e));
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

  return (
    <div
      ref={containerRef}
      className={`term-xterm-wrap${inputMode === "external" ? " term-xterm-wrap--live" : ""}`}
    />
  );
}
