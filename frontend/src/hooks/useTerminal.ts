import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import { invoke, Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTerminalStore } from "../stores/terminalStore";
import { useBlocksStore, createBlockId } from "../stores/blocksStore";

const TERMINAL_THEME = {
  background: "#1a1717",
  foreground: "#fdfcfc",
  cursor: "#007aff",
  cursorAccent: "#1a1717",
  selectionBackground: "rgba(0, 122, 255, 0.3)",
  selectionForeground: "#fdfcfc",
  black: "#201d1d",
  red: "#ff3b30",
  green: "#30d158",
  yellow: "#ff9f0a",
  blue: "#007aff",
  magenta: "#c084fc",
  cyan: "#64d2ff",
  white: "#fdfcfc",
  brightBlack: "#636366",
  brightRed: "#ff6961",
  brightGreen: "#5ee085",
  brightYellow: "#ffb340",
  brightBlue: "#4da3ff",
  brightMagenta: "#d4a0ff",
  brightCyan: "#8ee0ff",
  brightWhite: "#ffffff",
};

export function useTerminal(
  sessionId: string,
  containerRef: React.RefObject<HTMLDivElement | null>,
  onTerminalReady?: (terminal: Terminal, searchAddon: SearchAddon) => void,
  onCommand?: (command: string) => void,
  onBlockRightClick?: (block: import("../stores/blocksStore").TerminalBlock, position: { x: number; y: number }) => void
) {
  const termRef = useRef<Terminal | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const setTerminal = useTerminalStore((s) => s.setTerminal);
  const setStatus = useTerminalStore((s) => s.setStatus);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let term: Terminal | null = null;
    let fitAddon: FitAddon | null = null;
    let webglAddon: WebglAddon | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let disposables: { dispose(): void }[] = [];
    let unlistenPromise: Promise<() => void> | null = null;
    let destroyed = false;
    let contextmenuHandler: ((e: MouseEvent) => void) | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;

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

      // Read text from a specific buffer line, stripping ANSI codes
      function readLine(y: number): string {
        const line = t.buffer.active.getLine(y);
        if (!line) return "";
        let text = "";
        for (let i = 0; i < line.length; i++) {
          text += line.getCell(i)?.getChars() || "";
        }
        return text.replace(/\x1b\[[0-9;]*m/g, "").trim();
      }

      // OSC 133 — Shell integration protocol
      disposables.push(
        t.parser.registerOscHandler(133, (data: string) => {
          const parts = data.split(";");
          const code = parts[0];

          switch (code) {
            case "A": {
              // Prompt start — mark where the command block begins
              const y = t.buffer.active.cursorY + t.buffer.active.baseY;
              pendingBlock = { startLine: y, command: "", cwd: currentCwd };
              break;
            }
            case "B": {
              // Prompt end — prompt is displayed, user can type
              break;
            }
            case "C": {
              // Output start — user pressed Enter, command is on the current line
              const y = t.buffer.active.cursorY + t.buffer.active.baseY;
              const commandText = readLine(y);

              if (!pendingBlock) {
                pendingBlock = { startLine: y, command: commandText, cwd: currentCwd };
              } else {
                pendingBlock.command = commandText;
              }

              const marker = t.markers.add(y);
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
              // Command end
              const exitCode = parseInt(parts[1] || "0", 10);
              if (pendingBlock?.blockId) {
                const endLine =
                  t.buffer.active.cursorY + t.buffer.active.baseY;
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

      // OSC 1337 — iTerm2 extensions (current directory)
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

      // Open in container
      term.open(container!);
      fitAddon.fit();

      // Setup shell integration (OSC 133 + 1337 handlers)
      setupShellIntegration(term);

      // Wire up Tauri Channel for output streaming
      const onOutput = new Channel<Uint8Array>();
      onOutput.onmessage = (data: Uint8Array) => {
        if (destroyed) return;
        term!.write(data);
      };

      // Create terminal session on the backend
      invoke<string>("create_terminal", {
        cols: term.cols,
        rows: term.rows,
        onOutput,
      })
        .then(() => {
          if (destroyed) return;
          setStatus(sessionId, "connected");
        })
        .catch((err) => {
          if (destroyed) return;
          term!.writeln(`\x1b[31mFailed to create terminal: ${err}\x1b[0m`);
          setStatus(sessionId, "disconnected");
        });

      // Wire terminal input -> backend
      disposables.push(
        term.onData((data) => {
          if (destroyed) return;
          invoke("write_terminal", {
            id: sessionId,
            data: Array.from(new TextEncoder().encode(data)),
          });
        })
      );

      // Handle resize with debounce to avoid IPC flood
      resizeObserver = new ResizeObserver(() => {
        fitAddon!.fit();
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          if (destroyed) return;
          invoke("resize_terminal", {
            id: sessionId,
            cols: term!.cols,
            rows: term!.rows,
          });
        }, 100);
      });
      resizeObserver.observe(container!);

      // Listen for control events (process exit, etc.)
      unlistenPromise = listen<{ session_id: string; event: string }>(
        "terminal-event",
        (ev) => {
          if (destroyed) return;
          if (ev.payload.session_id === sessionId) {
            if (ev.payload.event === "exited") {
              setStatus(sessionId, "disconnected");
              term!.writeln("\r\n\x1b[33m[Process exited]\x1b[0m");
            }
          }
        }
      );

      // Store references
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
          return true; // Let xterm process the key normally
        });
      }

      // Right-click on terminal blocks — store handler for cleanup
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

      // Focus after open
      term.focus();

      // Notify parent that terminal is ready
      if (onTerminalReady && searchAddon) {
        onTerminalReady(term, searchAddon);
      }
    }

    // Use IntersectionObserver to init only when container is visible
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            if (!term) {
              initTerminal();
            } else {
              requestAnimationFrame(() => {
                if (destroyed) return;
                fitAddon?.fit();
                term?.focus();
              });
            }
          }
        }
      },
      { threshold: 0 }
    );
    observer.observe(container);

    // Cleanup
    return () => {
      destroyed = true;
      observer.disconnect();
      resizeObserver?.disconnect();
      if (resizeTimer) clearTimeout(resizeTimer);
      for (const d of disposables) d.dispose();
      unlistenPromise?.then((fn) => fn());
      webglAddon?.dispose();
      if (contextmenuHandler) {
        container.removeEventListener("contextmenu", contextmenuHandler);
      }
      if (term) {
        invoke("close_terminal", { id: sessionId }).catch(() => {});
        term.dispose();
      }
      termRef.current = null;
      searchAddonRef.current = null;
    };
  }, [sessionId]);

  return { termRef, searchAddonRef };
}
