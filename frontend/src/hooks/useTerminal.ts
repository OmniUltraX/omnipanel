import { useEffect, useRef, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { commands, type SshConfig } from "../ipc/bindings";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal, type IDisposable, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import {
  findTerminalPane,
  useTerminalStore,
} from "../stores/terminalStore";
import { useConnectionStore } from "../stores/connectionStore";
import { isOpenSshHostId, openSshHostAlias } from "../lib/sshConfigHosts";
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

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
  return arr;
}

function decodeOutput(data: unknown): Uint8Array | null {
  // 后端统一以 base64 字符串传输（terminal-output / terminal_snapshot）。
  if (typeof data === "string") return data.length === 0 ? new Uint8Array(0) : decodeBase64(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(data);
  return null;
}

/** Prevent concurrent create_terminal calls for the same pane (StrictMode / re-render races). */
const pendingBackendSessions = new Map<string, Promise<string>>();

function findPaneById(sessionId: string) {
  return findTerminalPane(sessionId);
}

function isRemotePane(sessionId: string): boolean {
  return findPaneById(sessionId)?.type === "remote";
}

/** 远程 pane 走 SSH（ssh_connect），本地 pane 走本地 PTY（create_terminal）。 */
async function createBackendSession(sessionId: string, cols: number, rows: number): Promise<string> {
  const pane = findPaneById(sessionId);
  if (pane?.type === "remote") {
    if (isOpenSshHostId(pane.resourceId)) {
      const alias = openSshHostAlias(pane.resourceId);
      if (!alias) {
        throw new Error("无效的 OpenSSH Host 标识");
      }
      const res = await commands.sshConnectConfigHost(alias, cols, rows);
      if (res.status === "ok") return res.data;
      throw new Error(res.error.message);
    }
    const conn = useConnectionStore.getState().connections.find((c) => c.id === pane.resourceId);
    if (!conn) {
      throw new Error("未找到对应的 SSH 连接配置，请先在 SSH 管理中添加连接");
    }
    let config: SshConfig;
    try {
      config = JSON.parse(conn.config || "{}") as SshConfig;
    } catch {
      throw new Error("SSH 连接配置解析失败");
    }
    const res = await commands.sshConnect(config, cols, rows);
    if (res.status === "ok") return res.data;
    throw new Error(res.error.message);
  }
  return invoke<string>("create_terminal", { cols, rows });
}

function disposeBackendSession(sessionId: string, backendSid: string) {
  const cmd = isRemotePane(sessionId) ? "ssh_disconnect" : "close_terminal";
  invoke(cmd, { id: backendSid }).catch(() => {});
}

/** 关闭窗格对应的后端 PTY/SSH（仅在用户关闭窗格/标签时调用，勿在 React 卸载时调用） */
export function disposePaneBackendSession(paneId: string) {
  const pane = findPaneById(paneId);
  if (!pane?.backendSessionId) return;
  disposeBackendSession(paneId, pane.backendSessionId);
  useTerminalStore.getState().setBackendSessionId(paneId, null);
}

export function disposeTabBackendSessions(tabId: string) {
  const tab = useTerminalStore.getState().tabs.find((item) => item.id === tabId);
  if (!tab) return;
  for (const pane of tab.panes) {
    disposePaneBackendSession(pane.id);
  }
}

async function acquireBackendSession(sessionId: string, cols: number, rows: number): Promise<string> {
  const existingSid = findPaneById(sessionId)?.backendSessionId;
  if (existingSid) return existingSid;

  let pending = pendingBackendSessions.get(sessionId);
  if (!pending) {
    pending = createBackendSession(sessionId, cols, rows)
      .then((sid) => {
        const pane = findPaneById(sessionId);
        if (pane?.backendSessionId) {
          disposeBackendSession(sessionId, sid);
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
    const remote = isRemotePane(sessionId);
    const writeCmd = remote ? "ssh_write" : "write_terminal";
    const resizeCmd = remote ? "ssh_resize" : "resize_terminal";
    // 重连恢复期间由后端快照统一重建屏幕，期间丢弃增量事件以避免重复。
    let restoring = false;

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
        invoke(writeCmd, {
          id: backendSid,
          data: toBytes(data),
        }).catch((err) => {
          console.error(`[Terminal ${sessionId}] ${writeCmd} failed:`, err);
        });
      }
      pendingInput = [];
    }

    function isSessionNotFoundError(err: unknown): boolean {
      return String(err).includes("not found");
    }

    function writeToBackend(data: string) {
      if (!backendSid) {
        pendingInput.push(data);
        return;
      }
      invoke(writeCmd, {
        id: backendSid,
        data: toBytes(data),
      }).catch((err) => {
        if (isSessionNotFoundError(err)) {
          useTerminalStore.getState().setBackendSessionId(sessionId, null);
          backendSid = null;
          pendingInput.push(data);
          if (term) {
            void ensureBackendSession(term.cols, term.rows);
          }
          return;
        }
        console.error(`[Terminal ${sessionId}] ${writeCmd} failed:`, err);
      });
    }

    function sendCommand(cmd: string) {
      writeToBackend(`${cmd}\r`);
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
          if (restoring) return;
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

    // 复用已有后端会话（前端 remount / 切回标签）时，用后端 scrollback 快照重建屏幕。
    async function restoreSnapshot() {
      if (!backendSid || !term) return;
      restoring = true;
      try {
        const b64 = await invoke<string>("terminal_snapshot", { id: backendSid });
        if (destroyed || !term) return;
        const bytes = decodeOutput(b64);
        term.reset();
        if (bytes && bytes.length > 0) term.write(bytes);
      } catch (err) {
        if (isSessionNotFoundError(err)) {
          useTerminalStore.getState().setBackendSessionId(sessionId, null);
          backendSid = null;
          if (term) {
            void ensureBackendSession(term.cols, term.rows);
          }
          return;
        }
        console.error(`[Terminal ${sessionId}] terminal_snapshot failed:`, err);
      } finally {
        restoring = false;
      }
    }

    async function ensureBackendSession(cols: number, rows: number) {
      const existingSid = findPaneById(sessionId)?.backendSessionId;

      if (existingSid) {
        backendSid = existingSid;
        useTerminalStore.getState().setStatus(sessionId, "connected");
        void restoreSnapshot();
        flushPendingInput();
        return;
      }

      useTerminalStore.getState().setStatus(sessionId, "connecting");
      try {
        const sid = await acquireBackendSession(sessionId, cols, rows);
        if (destroyed) return;
        backendSid = sid;
        useTerminalStore.getState().setStatus(sessionId, "connected");
        flushPendingInput();
      } catch (err) {
        if (destroyed) return;
        console.error(`[Terminal ${sessionId}] backend session failed:`, err);
        term?.writeln(`\r\n\x1b[31m${remote ? "SSH 连接失败" : "终端创建失败"}: ${err}\x1b[0m`);
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
            invoke(resizeCmd, {
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

        if (sendRef) {
          sendRef.current = sendCommandRef.current;
        }

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
