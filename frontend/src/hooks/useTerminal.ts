import { useEffect, useRef, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal, type IDisposable, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import { useTerminalStore } from "../stores/terminalStore";
import { getResourceById } from "../lib/resourceRegistry";
import { createBlockId, useBlocksStore, type TerminalBlock } from "../stores/blocksStore";

const TERMINAL_THEME: ITheme = {
  background: "#1a1717",
  foreground: "#f4f1ed",
  cursor: "#f4f1ed",
  selectionBackground: "#5b504a",
  black: "#1a1717",
  red: "#ff6b6b",
  green: "#51cf66",
  yellow: "#ffd43b",
  blue: "#74c0fc",
  magenta: "#da77f2",
  cyan: "#66d9e8",
  white: "#f4f1ed",
  brightBlack: "#7c6f66",
  brightRed: "#ff8787",
  brightGreen: "#69db7c",
  brightYellow: "#ffe066",
  brightBlue: "#91a7ff",
  brightMagenta: "#e599f7",
  brightCyan: "#99e9f2",
  brightWhite: "#fff9f0",
};

export type TerminalInputMode = "interactive" | "external";

export interface UseTerminalOptions {
  inputMode?: TerminalInputMode;
  /** When set and the pane is active, receives the sendCommand function for external input. */
  sendRef?: RefObject<((cmd: string) => void) | null>;
  /** Whether this pane is the currently active tab. */
  active?: boolean;
}

function toBytes(data: string): number[] {
  return Array.from(new TextEncoder().encode(data));
}

function decodeOutput(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(data);
  return null;
}

/** Prevent concurrent create_terminal calls for the same pane (StrictMode / re-render races). */
const pendingBackendSessions = new Map<string, Promise<string>>();

function findPaneById(sessionId: string) {
  return useTerminalStore
    .getState()
    .tabs.flatMap((tab) => tab.panes)
    .find((pane) => pane.id === sessionId);
}

async function acquireBackendSession(sessionId: string, cols: number, rows: number): Promise<string> {
  const existingSid = findPaneById(sessionId)?.backendSessionId;
  if (existingSid) return existingSid;

  let pending = pendingBackendSessions.get(sessionId);
  if (!pending) {
    pending = invoke<string>("create_terminal", { cols, rows })
      .then((sid) => {
        const pane = findPaneById(sessionId);
        if (pane?.backendSessionId) {
          invoke("close_terminal", { id: sid }).catch(() => {});
          return pane.backendSessionId;
        }
        useTerminalStore.getState().setBackendSessionId(sessionId, sid);
        return sid;
      })
      .finally(() => {
        pendingBackendSessions.delete(sessionId);
      });
    pendingBackendSessions.set(sessionId, pending);
  }
  return pending;
}

export function useTerminal(
  sessionId: string,
  containerRef: RefObject<HTMLDivElement | null>,
  onTerminalReady?: (terminal: Terminal, searchAddon: SearchAddon) => void,
  onCommand?: (command: string) => void,
  onBlockRightClick?: (block: TerminalBlock, position: { x: number; y: number }) => void,
  suspended = false,
  options: UseTerminalOptions = {},
) {
  const { inputMode = "interactive", sendRef, active = true } = options;
  const termRef = useRef<Terminal | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const sendCommandRef = useRef<((cmd: string) => void) | null>(null);
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;
  const onTerminalReadyRef = useRef(onTerminalReady);
  onTerminalReadyRef.current = onTerminalReady;
  const onCommandRef = useRef(onCommand);
  onCommandRef.current = onCommand;
  const onBlockRightClickRef = useRef(onBlockRightClick);
  onBlockRightClickRef.current = onBlockRightClick;
  const runtimeRef = useRef<{
    resizeObserver: ResizeObserver | null;
    fitAddon: FitAddon | null;
    container: HTMLDivElement | null;
    outputBuffer: Uint8Array[];
    initTerminal: (() => void) | null;
  }>({ resizeObserver: null, fitAddon: null, container: null, outputBuffer: [], initTerminal: null });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let term: Terminal | null = null;
    let fitAddon: FitAddon | null = null;
    let webglAddon: WebglAddon | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let destroyed = false;
    let contextmenuHandler: ((e: MouseEvent) => void) | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let backendSid: string | null = null;
    let pendingInput: string[] = [];
    let unlistenOutput: UnlistenFn | null = null;
    let unlistenEvent: UnlistenFn | null = null;
    const disposables: IDisposable[] = [];

    // Shell integration state
    let pendingBlock: {
      startLine: number;
      command: string;
      cwd: string;
      blockId?: string;
    } | null = null;
    let currentCwd = "";

    function flushPendingInput() {
      if (!backendSid) return;
      for (const data of pendingInput) {
        invoke("write_terminal", {
          id: backendSid,
          data: toBytes(data),
        }).catch((err) => {
          console.error(`[Terminal ${sessionId}] write_terminal failed:`, err);
        });
      }
      pendingInput = [];
    }

    function writeToBackend(data: string) {
      if (!backendSid) {
        pendingInput.push(data);
        return;
      }
      invoke("write_terminal", {
        id: backendSid,
        data: toBytes(data),
      }).catch((err) => {
        console.error(`[Terminal ${sessionId}] write_terminal failed:`, err);
      });
    }

    function sendCommand(cmd: string) {
      writeToBackend(`${cmd}\r`);
    }

    function writeSessionBanner() {
      const pane = useTerminalStore
        .getState()
        .tabs.flatMap((tab) => tab.panes)
        .find((item) => item.id === sessionId);
      if (pane?.type !== "remote" || !term) return;
      const host = getResourceById(pane.resourceId);
      term.writeln(`\r\n\x1b[33m[SSH] ${host?.name ?? pane.resourceId} · ${host?.subtitle ?? ""}\x1b[0m\r\n`);
    }

    sendCommandRef.current = sendCommand;

    function setupShellIntegration(t: Terminal) {
      const addBlock = useBlocksStore.getState().addBlock;
      const updateBlock = useBlocksStore.getState().updateBlock;

      function readLine(y: number): string {
        const line = t.buffer.active.getLine(y);
        if (!line) return "";
        let text = "";
        for (let i = 0; i < line.length; i++) {
          text += line.getCell(i)?.getChars() || "";
        }
        return text.replace(/\x1b\[[0-9;]*m/g, "").trim();
      }

      disposables.push(
        t.parser.registerOscHandler(133, (data: string) => {
          const parts = data.split(";");
          const code = parts[0];
          switch (code) {
            case "A": {
              const y = t.buffer.active.cursorY + t.buffer.active.baseY;
              pendingBlock = { startLine: y, command: "", cwd: currentCwd };
              break;
            }
            case "B":
              break;
            case "C": {
              const y = t.buffer.active.cursorY + t.buffer.active.baseY;
              const commandText = readLine(y);
              if (!pendingBlock) {
                pendingBlock = { startLine: y, command: commandText, cwd: currentCwd };
              } else {
                pendingBlock.command = commandText;
              }
              const marker = t.registerMarker(0);
              const blockId = createBlockId();
              addBlock(sessionId, {
                id: blockId,
                sessionId,
                command: pendingBlock.command,
                output: "",
                exitCode: null,
                startLine: pendingBlock.startLine,
                endLine: -1,
                marker,
                cwd: pendingBlock.cwd,
                timestamp: Date.now(),
                status: "running",
              });
              pendingBlock = { ...pendingBlock, blockId };
              break;
            }
            case "D": {
              const exitCode = parseInt(parts[1] || "0", 10);
              if (pendingBlock?.blockId) {
                const endLine = t.buffer.active.cursorY + t.buffer.active.baseY;
                updateBlock(pendingBlock.blockId, {
                  exitCode,
                  endLine,
                  status: exitCode === 0 ? "completed" : "failed",
                });
              }
              pendingBlock = null;
              break;
            }
          }
          return true;
        })
      );

      disposables.push(
        t.parser.registerOscHandler(1337, (data: string) => {
          if (data.startsWith("CurrentDir=")) {
            currentCwd = data.substring("CurrentDir=".length);
          }
          return true;
        })
      );
    }

    async function attachOutputListener() {
      unlistenOutput = await listen<{ session_id: string; data: unknown }>(
        "terminal-output",
        (ev) => {
          if (destroyed || ev.payload.session_id !== backendSid) return;
          try {
            const bytes = decodeOutput(ev.payload.data);
            if (!bytes) return;
            if (suspendedRef.current) {
              runtimeRef.current.outputBuffer.push(bytes);
              return;
            }
            term?.write(bytes);
          } catch (e) {
            console.error(`[Terminal ${sessionId}] terminal-output error:`, e);
          }
        }
      );
    }

    async function attachEventListener() {
      unlistenEvent = await listen<{ session_id: string; event: string }>(
        "terminal-event",
        (ev) => {
          if (destroyed || ev.payload.session_id !== backendSid) return;
          if (ev.payload.event === "exited") {
            useTerminalStore.getState().setStatus(sessionId, "disconnected");
            if (!suspendedRef.current) {
              term?.writeln("\r\n\x1b[33m[Process exited]\x1b[0m");
            }
          }
        }
      );
    }

    async function ensureBackendSession(cols: number, rows: number) {
      const existingSid = findPaneById(sessionId)?.backendSessionId;

      if (existingSid) {
        backendSid = existingSid;
        useTerminalStore.getState().setStatus(sessionId, "connected");
        writeSessionBanner();
        flushPendingInput();
        return;
      }

      useTerminalStore.getState().setStatus(sessionId, "connecting");
      try {
        const sid = await acquireBackendSession(sessionId, cols, rows);
        if (destroyed) return;
        backendSid = sid;
        useTerminalStore.getState().setStatus(sessionId, "connected");
        writeSessionBanner();
        flushPendingInput();
      } catch (err) {
        if (destroyed) return;
        console.error(`[Terminal ${sessionId}] create_terminal failed:`, err);
        term?.writeln(`\r\n\x1b[31mFailed to create terminal: ${err}\x1b[0m`);
        useTerminalStore.getState().setStatus(sessionId, "disconnected");
        pendingInput = [];
      }
    }

    function initTerminal() {
      if (destroyed || term || suspendedRef.current) return;

      try {
        term = new Terminal({
          cursorBlink: true,
          fontSize: 13,
          fontFamily:
            '"Berkeley Mono", "IBM Plex Mono", ui-monospace, "Cascadia Code", "Fira Code", Menlo, Consolas, monospace',
          theme: TERMINAL_THEME,
          allowProposedApi: true,
          scrollback: 10000,
        });

        fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        term.loadAddon(new WebLinksAddon());

        const searchAddon = new SearchAddon();
        term.loadAddon(searchAddon);
        searchAddonRef.current = searchAddon;

        try {
          webglAddon = new WebglAddon();
          term.loadAddon(webglAddon);
        } catch {
          // WebGL not available, fall back to canvas renderer
        }

        term.open(container!);
        fitAddon.fit();

        setupShellIntegration(term);

        void attachOutputListener();
        void attachEventListener();
        void ensureBackendSession(term.cols, term.rows);

        if (inputMode === "external") {
          term.attachCustomKeyEventHandler(() => false);
        } else {
          disposables.push(
            term.onData((data) => {
              if (destroyed) return;
              writeToBackend(data);
            })
          );
        }

        resizeObserver = new ResizeObserver(() => {
          if (suspendedRef.current || !fitAddon || !term) return;
          fitAddon.fit();
          if (resizeTimer) clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => {
            if (destroyed || !backendSid || suspendedRef.current) return;
            invoke("resize_terminal", {
              id: backendSid,
              cols: term!.cols,
              rows: term!.rows,
            }).catch(() => {});
          }, 100);
        });
        resizeObserver.observe(container!);
        runtimeRef.current.resizeObserver = resizeObserver;
        runtimeRef.current.fitAddon = fitAddon;
        runtimeRef.current.container = container!;

        termRef.current = term;
        useTerminalStore.getState().setTerminal(sessionId, term);

        if (onCommandRef.current) {
          term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
            if (e.key === "Enter" && !e.ctrlKey && !e.altKey && !e.metaKey && e.type === "keydown") {
              const buf = term!.buffer.active;
              const y = buf.cursorY + buf.baseY;
              const line = buf.getLine(y);
              if (line) {
                let text = "";
                for (let i = 0; i < line.length; i++) {
                  text += line.getCell(i)?.getChars() || "";
                }
                text = text.replace(/\x1b\[[0-9;]*m/g, "").trim();
                if (text.length > 0) {
                  onCommandRef.current?.(text);
                }
              }
            }
            return true;
          });
        }

        if (onBlockRightClickRef.current) {
          contextmenuHandler = (e: MouseEvent) => {
            if (!term || destroyed) return;
            const rect = container!.getBoundingClientRect();
            const cellHeight = rect.height / term.rows;
            const clickedRow = Math.floor(e.offsetY / cellHeight);
            const absoluteLine = clickedRow + term.buffer.active.viewportY;

            const blocks = useBlocksStore.getState().getBlocks(sessionId);
            const clickedBlock = blocks.find(
              (b) => b.startLine <= absoluteLine && (b.endLine === -1 || b.endLine >= absoluteLine)
            );

            if (clickedBlock) {
              e.preventDefault();
              onBlockRightClickRef.current?.(clickedBlock, { x: e.clientX, y: e.clientY });
            }
          };
          container!.addEventListener("contextmenu", contextmenuHandler);
        }

        term.focus();

        const readyCb = onTerminalReadyRef.current;
        if (readyCb && searchAddon) {
          readyCb(term, searchAddon);
        }
      } catch (err) {
        console.error(`[Terminal ${sessionId}] initTerminal failed:`, err);
      }
    }

    runtimeRef.current.initTerminal = initTerminal;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && !suspendedRef.current) {
            if (!term) {
              initTerminal();
            } else {
              requestAnimationFrame(() => {
                if (destroyed || suspendedRef.current) return;
                fitAddon?.fit();
                term?.focus();
              });
            }
          }
        }
      },
      { threshold: 0 },
    );
    observer.observe(container);

    return () => {
      destroyed = true;
      observer.disconnect();
      resizeObserver?.disconnect();
      if (resizeTimer) {
        clearTimeout(resizeTimer);
      }
      if (contextmenuHandler) {
        container.removeEventListener("contextmenu", contextmenuHandler);
      }
      sendCommandRef.current = null;
      for (const disposable of disposables) {
        disposable.dispose();
      }
      unlistenOutput?.();
      unlistenEvent?.();
      webglAddon?.dispose();
      if (term) {
        const pane = useTerminalStore
          .getState()
          .tabs.flatMap((tab) => tab.panes)
          .find((item) => item.id === sessionId);
        const sid = pane?.backendSessionId;
        if (sid) {
          invoke("close_terminal", { id: sid }).catch(() => {});
        }
        term.dispose();
      }
      termRef.current = null;
      searchAddonRef.current = null;
      runtimeRef.current.initTerminal = null;
    };
  }, [sessionId, inputMode]);

  useEffect(() => {
    const rt = runtimeRef.current;
    if (suspended) {
      rt.resizeObserver?.disconnect();
      return;
    }

    const term = termRef.current;
    if (rt.container && rt.resizeObserver) {
      rt.resizeObserver.observe(rt.container);
    }
    if (!term && rt.container && rt.initTerminal) {
      const rect = rt.container.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        rt.initTerminal();
      }
    }
    if (term && rt.outputBuffer.length > 0) {
      for (const bytes of rt.outputBuffer) {
        term.write(bytes);
      }
      rt.outputBuffer = [];
    }
    requestAnimationFrame(() => rt.fitAddon?.fit());
  }, [suspended]);

  useEffect(() => {
    if (!sendRef) return;
    if (active && !suspended) {
      sendRef.current = sendCommandRef.current;
    } else if (sendRef.current === sendCommandRef.current) {
      sendRef.current = null;
    }
  }, [active, sendRef, suspended]);

  return { termRef, searchAddonRef };
}
