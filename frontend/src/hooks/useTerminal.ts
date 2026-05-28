import { useEffect, useRef, type RefObject } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal, type IDisposable, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import { useTerminalStore } from "../stores/terminalStore";
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

export function useTerminal(
  sessionId: string,
  containerRef: RefObject<HTMLDivElement | null>,
  onTerminalReady?: (terminal: Terminal, searchAddon: SearchAddon) => void,
  onCommand?: (command: string) => void,
  onBlockRightClick?: (block: TerminalBlock, position: { x: number; y: number }) => void,
  suspended = false,
) {
  const termRef = useRef<Terminal | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;
  const runtimeRef = useRef<{
    resizeObserver: ResizeObserver | null;
    fitAddon: FitAddon | null;
    container: HTMLDivElement | null;
    outputBuffer: Uint8Array[];
  }>({ resizeObserver: null, fitAddon: null, container: null, outputBuffer: [] });
  const setTerminal = useTerminalStore((s) => s.setTerminal);
  const setStatus = useTerminalStore((s) => s.setStatus);

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
    let unlistenPromise: Promise<UnlistenFn> | null = null;
    const disposables: IDisposable[] = [];

    // Shell integration state
    let pendingBlock: {
      startLine: number;
      command: string;
      cwd: string;
      blockId?: string;
    } | null = null;
    let currentCwd = "";

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

    function initTerminal() {
      if (destroyed || term) return;

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

        // Wire up Tauri Channel for output streaming
        // Pass callback directly in constructor — more reliable than setting .onmessage
        const onOutput = new Channel((data: unknown) => {
          if (destroyed) return;
          try {
            const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as number[]);
            if (suspendedRef.current) {
              runtimeRef.current.outputBuffer.push(bytes);
              return;
            }
            term!.write(bytes);
          } catch (e) {
            console.error(`[Terminal ${sessionId}] onOutput error:`, e, "data:", data);
          }
        });

        // Create terminal session on the backend
        invoke<string>("create_terminal", {
          cols: term.cols,
          rows: term.rows,
          onOutput,
        })
          .then((sid) => {
            if (destroyed) return;
            backendSid = sid;
            useTerminalStore.getState().setBackendSessionId(sessionId, sid);
            setStatus(sessionId, "connected");
            // Flush any buffered input
            for (const data of pendingInput) {
              invoke("write_terminal", {
                id: sid,
                data: Array.from(new TextEncoder().encode(data)),
              });
            }
            pendingInput = [];
          })
          .catch((err) => {
            if (destroyed) return;
            console.error(`[Terminal ${sessionId}] create_terminal failed:`, err);
            term!.writeln(`\r\n\x1b[31mFailed to create terminal: ${err}\x1b[0m`);
            setStatus(sessionId, "disconnected");
            pendingInput = [];
          });

        // Wire terminal input -> backend
        disposables.push(
          term.onData((data) => {
            if (destroyed) return;
            if (!backendSid) {
              pendingInput.push(data);
              return;
            }
            invoke("write_terminal", {
              id: backendSid,
              data: Array.from(new TextEncoder().encode(data)),
            }).catch((err) => {
              console.error(`[Terminal ${sessionId}] write_terminal failed:`, err);
            });
          })
        );

        // Handle resize with debounce
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

        // Listen for process exit
        unlistenPromise = listen<{ session_id: string; event: string }>(
          "terminal-event",
          (ev) => {
            if (destroyed) return;
            if (ev.payload.session_id === backendSid) {
              if (ev.payload.event === "exited") {
                setStatus(sessionId, "disconnected");
                if (!suspendedRef.current) {
                  term!.writeln("\r\n\x1b[33m[Process exited]\x1b[0m");
                }
              }
            }
          }
        );

        termRef.current = term;
        setTerminal(sessionId, term);

        // Intercept Enter key for command detection
        if (onCommand) {
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
                  onCommand(text);
                }
              }
            }
            return true;
          });
        }

        // Right-click on terminal blocks
        if (onBlockRightClick) {
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
              onBlockRightClick(clickedBlock, { x: e.clientX, y: e.clientY });
            }
          };
          container!.addEventListener("contextmenu", contextmenuHandler);
        }

        term.focus();

        if (onTerminalReady && searchAddon) {
          onTerminalReady(term, searchAddon);
        }
      } catch (err) {
        console.error(`[Terminal ${sessionId}] initTerminal failed:`, err);
      }
    }

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
      for (const disposable of disposables) {
        disposable.dispose();
      }
      unlistenPromise?.then((unlisten) => unlisten()).catch(() => {});
      webglAddon?.dispose();
      if (term) {
        const sid = useTerminalStore.getState().tabs.find((t) => t.id === sessionId)?.backendSessionId;
        if (sid) {
          invoke("close_terminal", { id: sid }).catch(() => {});
        }
        term.dispose();
      }
      termRef.current = null;
      searchAddonRef.current = null;
    };
  }, [containerRef, onBlockRightClick, onCommand, onTerminalReady, sessionId, setStatus, setTerminal]);

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
    if (term && rt.outputBuffer.length > 0) {
      for (const bytes of rt.outputBuffer) {
        term.write(bytes);
      }
      rt.outputBuffer = [];
    }
    requestAnimationFrame(() => rt.fitAddon?.fit());
  }, [suspended]);

  return { termRef, searchAddonRef };
}
