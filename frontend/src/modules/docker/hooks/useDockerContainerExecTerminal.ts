import { useEffect, useRef, type RefObject } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { commands } from "../../../ipc/bindings";
import { TERMINAL_EVENT, TERMINAL_OUTPUT } from "../../../ipc/events";
import { unwrapCommand } from "../../../ipc/result";
import { safeTauriUnlisten } from "../../../lib/safeTauriUnlisten";
import { useSettingsStore } from "../../../stores/settingsStore";

const TERMINAL_THEME = {
  background: "#1a1717",
  foreground: "#f4f1ed",
  cursor: "#f4f1ed",
  selectionBackground: "#5b504a",
};

function toBytes(data: string): number[] {
  return Array.from(new TextEncoder().encode(data));
}

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    arr[i] = bin.charCodeAt(i);
  }
  return arr;
}

export function useDockerContainerExecTerminal(
  connectionId: string,
  containerId: string,
  containerRef: RefObject<HTMLDivElement | null>,
  enabled: boolean,
  execSupported: boolean,
) {
  const backendSessionRef = useRef<string | null>(null);

  useEffect(() => {
    const mount = containerRef.current;
    if (!enabled || !execSupported || !mount) {
      return;
    }

    const settings = useSettingsStore.getState();
    const term = new Terminal({
      cursorBlink: settings.terminalCursorBlink,
      cursorStyle: settings.terminalCursorStyle,
      fontSize: settings.terminalFontSize,
      fontFamily: `"${settings.terminalFontFamily}", "Cascadia Code", "Fira Code", Menlo, Consolas, monospace`,
      lineHeight: settings.terminalLineHeight,
      theme: TERMINAL_THEME,
      scrollback: settings.terminalScrollback,
      allowTransparency: false,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(mount);
    fitAddon.fit();

    let cancelled = false;
    let outputUnlisten: UnlistenFn | null = null;
    let eventUnlisten: UnlistenFn | null = null;

    const dataDisposable = term.onData((data) => {
      const sessionId = backendSessionRef.current;
      if (!sessionId) return;
      void commands.dockerExecWrite(sessionId, toBytes(data));
    });

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      const sessionId = backendSessionRef.current;
      if (!sessionId) return;
      void commands.dockerExecResize(sessionId, term.cols, term.rows);
    });
    resizeObserver.observe(mount);

    void (async () => {
      try {
        const sessionId = await unwrapCommand(
          commands.dockerCreateExecSession(
            connectionId,
            containerId,
            null,
            term.cols,
            term.rows,
          ),
        );
        if (cancelled) {
          void commands.dockerExecClose(sessionId);
          return;
        }
        backendSessionRef.current = sessionId;

        outputUnlisten = await listen<{ session_id?: string; data?: string }>(
          TERMINAL_OUTPUT,
          (event) => {
            if (event.payload.session_id !== backendSessionRef.current) return;
            const bytes = decodeBase64(event.payload.data ?? "");
            term.write(bytes);
          },
        );

        eventUnlisten = await listen<{ session_id?: string; event?: string }>(
          TERMINAL_EVENT,
          (event) => {
            if (event.payload.session_id !== backendSessionRef.current) return;
            if (event.payload.event === "exited") {
              term.writeln("\r\n\x1b[90m[session closed]\x1b[0m");
            }
          },
        );
      } catch (error) {
        term.writeln(`\x1b[31m${String(error)}\x1b[0m`);
      }
    })();

    return () => {
      cancelled = true;
      dataDisposable.dispose();
      resizeObserver.disconnect();
      const sessionId = backendSessionRef.current;
      backendSessionRef.current = null;
      if (sessionId) {
        void commands.dockerExecClose(sessionId);
      }
      safeTauriUnlisten(outputUnlisten);
      safeTauriUnlisten(eventUnlisten);
      term.dispose();
    };
  }, [connectionId, containerId, containerRef, enabled, execSupported]);
}
