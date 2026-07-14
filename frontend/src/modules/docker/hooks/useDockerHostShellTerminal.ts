import { useEffect, useRef, type RefObject } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { commands } from "../../../ipc/bindings";
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

/** SSH 宿主机 Docker shell：输出经 terminal-output，写入经 dockerExec*。 */
export function useDockerHostShellTerminal(
  connectionId: string,
  containerRef: RefObject<HTMLDivElement | null>,
  enabled: boolean,
) {
  const backendSessionRef = useRef<string | null>(null);

  useEffect(() => {
    const mount = containerRef.current;
    if (!enabled || !mount) {
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
        const res = await commands.dockerCreateHostShellSession(
          connectionId,
          term.cols,
          term.rows,
        );
        if (res.status !== "ok") {
          throw new Error(res.error.message);
        }
        if (cancelled) {
          void commands.dockerExecClose(res.data);
          return;
        }
        backendSessionRef.current = res.data;

        outputUnlisten = await listen<{ session_id?: string; data?: string }>(
          "terminal-output",
          (event) => {
            if (event.payload.session_id !== backendSessionRef.current) return;
            const bytes = decodeBase64(event.payload.data ?? "");
            term.write(bytes);
          },
        );

        eventUnlisten = await listen<{ session_id?: string; event?: string }>(
          "terminal-event",
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
  }, [connectionId, containerRef, enabled]);
}

/** 本地 Docker：直接打开本机 PTY，可在其中执行 docker CLI。 */
export function useLocalDockerShellTerminal(
  containerRef: RefObject<HTMLDivElement | null>,
  enabled: boolean,
) {
  const backendSessionRef = useRef<string | null>(null);

  useEffect(() => {
    const mount = containerRef.current;
    if (!enabled || !mount) {
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
      void commands.writeTerminal(sessionId, toBytes(data));
    });

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      const sessionId = backendSessionRef.current;
      if (!sessionId) return;
      void commands.resizeTerminal(sessionId, term.cols, term.rows);
    });
    resizeObserver.observe(mount);

    void (async () => {
      try {
        const res = await commands.createTerminal(term.cols, term.rows);
        if (res.status !== "ok") {
          throw new Error(typeof res.error === "string" ? res.error : String(res.error));
        }
        if (cancelled) {
          void commands.closeTerminal(res.data);
          return;
        }
        backendSessionRef.current = res.data;

        outputUnlisten = await listen<{ session_id?: string; data?: string }>(
          "terminal-output",
          (event) => {
            if (event.payload.session_id !== backendSessionRef.current) return;
            const bytes = decodeBase64(event.payload.data ?? "");
            term.write(bytes);
          },
        );

        eventUnlisten = await listen<{ session_id?: string; event?: string }>(
          "terminal-event",
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
        void commands.closeTerminal(sessionId);
      }
      safeTauriUnlisten(outputUnlisten);
      safeTauriUnlisten(eventUnlisten);
      term.dispose();
    };
  }, [containerRef, enabled]);
}
