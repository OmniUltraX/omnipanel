import { useEffect, useRef, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  commands,
  type SshConfig_Serialize,
} from "../ipc/bindings";
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
import { useSettingsStore } from "../stores/settingsStore";
import { isOpenSshHostId, openSshHostAlias } from "../lib/sshConfigHosts";
import { createBlockId, useBlocksStore, type TerminalBlock } from "../stores/blocksStore";
import { createTerminalOutputBatcher } from "../lib/terminalOutputBatcher";
import { decodeTerminalBytes, extractCommandOutput, normalizeBlockCommand, resolveBlockStatus } from "../modules/terminal/terminalOutputText";
import {
  claimFeedCaptureBlockId,
  clearOutputWatch,
  feedTerminalOutputForWatch,
  hasActiveFeedCapture,
  releaseFeedCapture,
} from "../modules/terminal/executeTerminalCommand";
import {
  trackTerminalOutputForAutoReturn,
  tryAutoReturnAfterBlockEnd,
} from "../modules/terminal/terminalAutoReturn";
import { isWarpDisplay } from "../modules/terminal/terminalDisplayMode";
import { triggerAiDrawerToggle } from "./useAiDrawerShortcut";
import { useModuleVisibility } from "../lib/moduleVisibility";

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

type TerminalInputBinding = { dispose: () => void };

function bindTerminalInputMode(
  term: Terminal,
  mode: TerminalInputMode,
  writeToBackend: (data: string) => void,
  previous?: TerminalInputBinding | null,
): TerminalInputBinding {
  previous?.dispose();

  let inputDisposable: IDisposable | undefined;

  if (mode === "external") {
    // 外部 Command Bar 模式：吞掉 xterm 键盘输入，仅保留 AI 快捷键
    term.attachCustomKeyEventHandler((e) => {
      triggerAiDrawerToggle(e);
      return false;
    });
  } else {
    // 直通模式：仅拦截 AI 快捷键，其余按键交给 xterm → onData → PTY
    term.attachCustomKeyEventHandler((e) => {
      if (triggerAiDrawerToggle(e)) return false;
      return true;
    });
    inputDisposable = term.onData(writeToBackend);
    requestAnimationFrame(() => term.focus());
  }

  return {
    dispose: () => inputDisposable?.dispose(),
  };
}

export type TerminalInputMode = "interactive" | "external";

export interface UseTerminalOptions {
  inputMode?: TerminalInputMode;
  /** When set and the pane is active, receives the sendCommand function for external input. */
  sendRef?: RefObject<((cmd: string) => void) | null>;
  /** Whether this pane is the currently active tab. */
  active?: boolean;
  /**
   * 重新连接计数器：父组件自增后会触发主 effect 重新执行，
   * 用于 pane header 上的"刷新"按钮，强制重建后端会话。
   */
  reconnectKey?: number;
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
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof data === "string") return data.length === 0 ? new Uint8Array(0) : decodeBase64(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(data);
  return null;
}

/** Prevent concurrent create_terminal calls for the same pane (StrictMode / re-render races). */
const pendingBackendSessions = new Map<string, Promise<string>>();

/** 记录已经成功注入钩子的后端会话 ID，避免切 Tab 时重复注入 */
const injectedBackendSessions = new Set<string>();

/** 切换窗格服务器前清除进行中的后端创建任务 */
export function clearPaneBackendPending(paneId: string) {
  pendingBackendSessions.delete(paneId);
}

function findPaneById(sessionId: string) {
  return findTerminalPane(sessionId);
}

function isRemotePane(sessionId: string): boolean {
  return findPaneById(sessionId)?.type === "remote";
}

/**
 * 把持久化配置（`SshConfig_Serialize` 形态 = serde 内部 tag 的扁平 JSON）
 * 透传给后端。
 *
 * 后端 `SshAuth` 使用 `#[serde(tag = "type", rename_all = "camelCase")]`，
 * 即 internally tagged —— JSON 线缆格式就是 `{ type: "password", password }`，
 * 与持久化在 `conn.config` 里的形态一致（见 `serverConnection.ts:155`）。
 * 这里不再做形态转换；旧的嵌套转换会把 `auth` 变成 `{ password: { type } }`，
 * 触发后端 `missing field \`type\`` 报错。
 */
function toSshConnectConfig(config: SshConfig_Serialize): SshConfig_Serialize {
  return config;
}

/** 远程 pane 走 SSH（ssh_connect），本地 pane 走本地 PTY（create_terminal）。 */
async function createBackendSession(sessionId: string, cols: number, rows: number): Promise<string> {
  const pane = findPaneById(sessionId);
  if (pane?.type === "remote" && pane.resourceId) {
    if (isOpenSshHostId(pane.resourceId)) {
      const alias = openSshHostAlias(pane.resourceId);
      if (!alias) {
        throw new Error("无效的 OpenSSH Host 标识");
      }
      const res = await commands.sshConnectConfigHost(alias, cols, rows);
      if (res.status === "ok") return res.data;
      throw normalizeBackendError(res.error, "OpenSSH Host 终端创建失败");
    }
    const conn = useConnectionStore.getState().connections.find((c) => c.id === pane.resourceId);
    if (!conn) {
      throw new Error("未找到对应的 SSH 连接配置，请先在 SSH 管理中添加连接");
    }
    let config: SshConfig_Serialize;
    try {
      config = JSON.parse(conn.config || "{}") as SshConfig_Serialize;
    } catch {
      throw new Error("SSH 连接配置解析失败");
    }
    const res = await commands.sshConnect(
      // specta 生成的 `SshConfig_Deserialize` 形态与 Rust serde 实际接受的
      // internally-tagged 扁平 JSON 不一致；这里把已校验的 Serialize 形态直传，
      // 通过 unknown 绕过错误的 Deserialize 类型。后端只接受扁平形态。
      toSshConnectConfig(config) as unknown as Parameters<typeof commands.sshConnect>[0],
      cols,
      rows,
    );
    if (res.status === "ok") return res.data;
    throw normalizeBackendError(res.error, "SSH 终端创建失败");
  }
  return invoke<string>("create_terminal", { cols, rows }).catch((err) => {
    throw normalizeBackendError(err, "本地 PTY 创建失败");
  });
}

/**
 * 把后端返回的 OmniError（或任何未知形态）规整为带 code/cause 的 Error。
 *
 * 背景：specta 生成的 `typedError` 在两种路径下都可能丢失 message：
 *   1) 后端返 `Result::Err(OmniError)`，Tauri IPC 直接 reject 序列化对象，
 *      `e instanceof Error === false`，`res.error.message` 正常。
 *   2) 当后端抛出非结构体 Error（如 anyhow 转的 `String`/`Error`）时，
 *      Tauri 会 reject 一个 JS Error，typedError 内部 `throw e` 重抛。
 *      上层 await 会再次拿到 Error 实例，其默认 message 就是 "Error"。
 * 这两种情况都收拢到本函数，避免 productionDiagnostics 看到裸 "Error"。
 */
function normalizeBackendError(
  raw: unknown,
  fallback: string,
): Error {
  if (raw instanceof Error) {
    const text = raw.message && raw.message !== "Error" ? raw.message : fallback;
    const err = new Error(text);
    (err as Error & { cause?: unknown }).cause = raw.cause ?? raw;
    return err;
  }
  if (raw && typeof raw === "object") {
    const obj = raw as { code?: unknown; message?: unknown; cause?: unknown };
    const message =
      typeof obj.message === "string" && obj.message.trim() && obj.message !== "Error"
        ? obj.message
        : fallback;
    const err = new Error(message);
    Object.assign(err, { code: obj.code ?? null, cause: obj.cause ?? null });
    return err;
  }
  if (typeof raw === "string" && raw.trim() && raw !== "Error") {
    return new Error(raw);
  }
  return new Error(fallback);
}

/** 把 Error 渲染为单行可写终端的字符串（包含 code / cause）。 */
function formatTerminalError(err: unknown, remote: boolean): string {
  // 后端 OmniError.message 已经描述了失败类别（如 "SSH 连接失败"），
  // 不再前置 header 避免重复。code / cause 仍拼到尾部供排障。
  if (err instanceof Error) {
    const extras: string[] = [];
    const maybe = err as Error & { code?: unknown; cause?: unknown };
    if (maybe.code) extras.push(`code=${String(maybe.code)}`);
    if (maybe.cause) {
      const causeText =
        maybe.cause instanceof Error
          ? maybe.cause.message
          : typeof maybe.cause === "string"
            ? maybe.cause
            : safeStringify(maybe.cause);
      if (causeText && causeText !== err.message) extras.push(`cause=${causeText}`);
    }
    const tail = extras.length > 0 ? ` (${extras.join(", ")})` : "";
    return `${err.message || (remote ? "SSH 连接失败" : "终端创建失败")}${tail}`;
  }
  return safeStringify(err);
}

function safeStringify(value: unknown): string {
  try {
    if (typeof value === "string") return value;
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function disposeBackendSession(sessionId: string, backendSid: string) {
  const cmd = isRemotePane(sessionId) ? "ssh_disconnect" : "close_terminal";
  invoke(cmd, { id: backendSid }).catch(() => { });
}

const REMOTE_CWD_HOOK_TOKEN = "__OMNIPANEL_CWD_HOOK";
const REMOTE_INIT_DONE_TOKEN = "\x1b]1337;OmniPanelInit___OMNIPANEL_CWD_HOOK\x07";

function createRemoteInitEchoFilter(emit: (bytes: Uint8Array) => void) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let active = true;
  let buffered = "";

  function emitText(text: string) {
    if (!text) return;
    emit(encoder.encode(text));
  }

  function flushTail() {
    const tail = buffered + decoder.decode();
    buffered = "";
    emitText(tail);
  }

  return {
    push(bytes: Uint8Array) {
      if (!active) {
        emit(bytes);
        return false;
      }
      buffered += decoder.decode(bytes, { stream: true });
      let newlineIndex = buffered.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffered.slice(0, newlineIndex + 1);
        buffered = buffered.slice(newlineIndex + 1);
        if (line.includes(REMOTE_INIT_DONE_TOKEN)) {
          active = false;
          flushTail();
          return false;
        } else if (line.includes(REMOTE_CWD_HOOK_TOKEN)) {
          // Drop echo but stay active
        } else {
          emitText(line);
        }
        newlineIndex = buffered.indexOf("\n");
      }
      return true;
    },
    releasePending() {
      if (!active) return false;
      active = false;
      flushTail();
      return false;
    },
  };
}

/** 远端 shell 注入 OSC 133 block 边界 + cwd 上报 */
function injectRemoteShellIntegration(write: (data: string) => void) {
  const script = [
    "if [ -z \"${__OMNIPANEL_SHELL_INT-}\" ]; then",
    "export __OMNIPANEL_SHELL_INT=1;",
    "__omnipanel_prompt_start() { printf \"\\033]133;A\\007\"; printf \"\\033]1337;CurrentDir=%s\\007\" \"$PWD\"; };",
    "__omnipanel_cmd_start() { printf \"\\033]133;C\\007\"; };",
    "__omnipanel_cmd_end() { printf \"\\033]133;D;%s\\007\" \"$?\"; };",
    "if [ -n \"${BASH_VERSION:-}\" ]; then",
    "__omnipanel_in_prompt=0;",
    "__omnipanel_pc() { __omnipanel_in_prompt=1; __omnipanel_cmd_end; __omnipanel_prompt_start; __omnipanel_in_prompt=0; };",
    "PROMPT_COMMAND=\"__omnipanel_pc${PROMPT_COMMAND:+;$PROMPT_COMMAND}\";",
    "trap '(( __omnipanel_in_prompt == 0 )) && __omnipanel_cmd_start' DEBUG;",
    "elif [ -n \"${ZSH_VERSION:-}\" ]; then",
    "autoload -Uz add-zsh-hook 2>/dev/null;",
    "add-zsh-hook precmd __omnipanel_prompt_start;",
    "add-zsh-hook precmd __omnipanel_cmd_end;",
    "add-zsh-hook preexec __omnipanel_cmd_start;",
    "fi;",
    "__omnipanel_prompt_start;",
    "fi;",
    "printf \"\\033]1337;%s\\007\\n\" \"OmniPanelInit___OMNIPANEL_CWD_HOOK\"",
  ].join(" ");
  write(`${script}\r`);
}

/** 关闭窗格对应的后端 PTY/SSH（仅在用户关闭窗格/标签时调用，勿在 React 卸载时调用） */
export function disposePaneBackendSession(paneId: string) {
  const pane = findPaneById(paneId);
  if (!pane?.backendSessionId) return;
  disposeBackendSession(paneId, pane.backendSessionId);
  injectedBackendSessions.delete(pane.backendSessionId);
  useTerminalStore.getState().setBackendSessionId(paneId, null);
}

/** 关闭 Tab 对应的后端 PTY/SSH（仅在用户关闭标签时调用） */
export function disposeTabBackendSessions(tabId: string) {
  const tab = useTerminalStore.getState().tabs.find((item) => item.id === tabId);
  if (!tab) return;
  if (!tab.backendSessionId) return;
  disposeBackendSession(tabId, tab.backendSessionId);
  injectedBackendSessions.delete(tab.backendSessionId);
  useTerminalStore.getState().setBackendSessionId(tabId, null);
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
  const { inputMode = "interactive", sendRef, active = true, reconnectKey = 0 } = options;
  const inputModeRef = useRef(inputMode);
  inputModeRef.current = inputMode;
  const writeToBackendRef = useRef<(data: string) => void>(() => {});
  const inputBindingRef = useRef<TerminalInputBinding | null>(null);
  const { active: moduleActive } = useModuleVisibility();
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

    writeToBackendRef.current = writeToBackend;

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
                pendingBlock.command = commandText || pendingBlock.command;
              }

              const existingBlockId = pendingBlock.blockId;
              if (existingBlockId) {
                const cmd = normalizeBlockCommand(commandText);
                if (cmd) {
                  useBlocksStore.getState().updateBlock(existingBlockId, { command: cmd });
                }
                break;
              }

              const captureBlockId = claimFeedCaptureBlockId(sessionId);
              if (captureBlockId) {
                const cmd = normalizeBlockCommand(commandText);
                if (cmd) {
                  useBlocksStore.getState().updateBlock(captureBlockId, { command: cmd });
                }
                pendingBlock = { ...pendingBlock, blockId: captureBlockId };
                break;
              }
              const effectiveCmd = (pendingBlock.command || commandText).trim();
              if (!effectiveCmd) {
                pendingBlock = null;
                break;
              }
              const marker = t.registerMarker(0);
              const blockId = createBlockId();
              addBlock(sessionId, {
                id: blockId,
                sessionId,
                kind: "shell",
                command: effectiveCmd,
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
                const blockId = pendingBlock.blockId;
                const endLine = t.buffer.active.cursorY + t.buffer.active.baseY;
                const existing = useBlocksStore.getState().findBlockById(blockId);
                const cmd = normalizeBlockCommand(existing?.command ?? pendingBlock.command);
                const cleaned =
                  existing && cmd
                    ? extractCommandOutput(existing.output, cmd)
                    : "";
                updateBlock(blockId, {
                  exitCode,
                  endLine,
                  status: resolveBlockStatus(exitCode),
                  ...(cleaned ? { output: cleaned } : {}),
                });
                tryAutoReturnAfterBlockEnd(sessionId, blockId);
                trimXtermAfterBlockEnd(t);
                clearOutputWatch(sessionId);
                releaseFeedCapture(sessionId);
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
            const next = data.substring("CurrentDir=".length);
            if (next && next !== currentCwd) {
              currentCwd = next;
              useTerminalStore.getState().setSessionCwd(sessionId, next);
            }
          }
          return true;
        })
      );
    }

    let outputBatcher: ReturnType<typeof createTerminalOutputBatcher> | null = null;
    let remoteInitEchoFilter: ReturnType<typeof createRemoteInitEchoFilter> | null = null;
    let remoteInitEchoFilterTimer: number | null = null;

    function queueOutput(bytes: Uint8Array) {
      outputBatcher?.push(bytes);
    }

    function trimXtermAfterBlockEnd(t: Terminal) {
      if (!isWarpDisplay(sessionId)) return;
      t.clear();
    }

    function shouldWriteToXterm(): boolean {
      if (suspendedRef.current) return false;
      if (!isWarpDisplay(sessionId)) return true;
      return Boolean(pendingBlock?.blockId) || hasActiveFeedCapture(sessionId);
    }

    async function attachOutputListener() {
      outputBatcher = createTerminalOutputBatcher((merged) => {
        trackTerminalOutputForAutoReturn(sessionId, merged);
        const text = decodeTerminalBytes(merged);
        feedTerminalOutputForWatch(sessionId, text);
        const outputBlockId =
          pendingBlock?.blockId ?? claimFeedCaptureBlockId(sessionId);
        if (outputBlockId) {
          useBlocksStore.getState().appendBlockOutput(outputBlockId, text);
        }
        if (suspendedRef.current) {
          runtimeRef.current.outputBuffer.push(merged);
          return;
        }
        if (shouldWriteToXterm()) {
          term?.write(merged);
        }
      });
      if (remote) {
        remoteInitEchoFilter = createRemoteInitEchoFilter(queueOutput);
      }
      unlistenOutput = await listen<{ session_id: string; data: unknown }>(
        "terminal-output",
        (ev) => {
          if (destroyed || ev.payload.session_id !== backendSid) return;
          if (restoring) return;
          try {
            const bytes = decodeOutput(ev.payload.data);
            if (!bytes) return;
            if (remoteInitEchoFilter) {
              const stillActive = remoteInitEchoFilter.push(bytes);
              if (!stillActive) {
                remoteInitEchoFilter = null;
                if (remoteInitEchoFilterTimer) {
                  clearTimeout(remoteInitEchoFilterTimer);
                  remoteInitEchoFilterTimer = null;
                }
              }
              return;
            }
            queueOutput(bytes);
          } catch (e) {
            console.error(`[Terminal ${sessionId}] terminal-output error:`, e);
          }
        },
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
        if (isWarpDisplay(sessionId)) {
          term.clear();
        }
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
        if (remote) {
          if (!injectedBackendSessions.has(backendSid)) {
            injectedBackendSessions.add(backendSid);
            if (remoteInitEchoFilter && !remoteInitEchoFilterTimer) {
              remoteInitEchoFilterTimer = window.setTimeout(() => {
                if (remoteInitEchoFilter) {
                  remoteInitEchoFilter.releasePending();
                  remoteInitEchoFilter = null;
                }
              }, 10000);
            }
            window.setTimeout(() => {
              if (!destroyed) injectRemoteShellIntegration(writeToBackend);
            }, 300);
          } else if (remoteInitEchoFilter) {
            remoteInitEchoFilter.releasePending();
            remoteInitEchoFilter = null;
          }
        }
        return;
      }

      useTerminalStore.getState().setStatus(sessionId, "connecting");
      try {
        const sid = await acquireBackendSession(sessionId, cols, rows);
        if (destroyed) return;
        backendSid = sid;
        useTerminalStore.getState().setStatus(sessionId, "connected");
        flushPendingInput();
        if (remote) {
          if (!injectedBackendSessions.has(backendSid)) {
            injectedBackendSessions.add(backendSid);
            if (remoteInitEchoFilter && !remoteInitEchoFilterTimer) {
              remoteInitEchoFilterTimer = window.setTimeout(() => {
                if (remoteInitEchoFilter) {
                  remoteInitEchoFilter.releasePending();
                  remoteInitEchoFilter = null;
                }
              }, 10000);
            }
            window.setTimeout(() => {
              if (!destroyed) injectRemoteShellIntegration(writeToBackend);
            }, 300);
          } else if (remoteInitEchoFilter) {
            remoteInitEchoFilter.releasePending();
            remoteInitEchoFilter = null;
          }
        }
      } catch (err) {
        if (destroyed) return;
        console.error(`[Terminal ${sessionId}] backend session failed:`, err);
        const formatted = formatTerminalError(err, remote);
        term?.writeln(`\r\n\x1b[31m${formatted}\x1b[0m`);
        useTerminalStore.getState().setStatus(sessionId, "disconnected");
        pendingInput = [];
        if (remoteInitEchoFilter) {
          remoteInitEchoFilter.releasePending();
          remoteInitEchoFilter = null;
        }
      }
    }

    function initTerminal() {
      if (destroyed || term || suspendedRef.current) return;

      try {
        const settings = useSettingsStore.getState();
        term = new Terminal({
          cursorBlink: settings.terminalCursorBlink,
          cursorStyle: settings.terminalCursorStyle,
          fontSize: settings.terminalFontSize,
          fontFamily: `"${settings.terminalFontFamily}", "IBM Plex Mono", ui-monospace, "Cascadia Code", "Fira Code", Menlo, Consolas, monospace`,
          lineHeight: settings.terminalLineHeight,
          theme: TERMINAL_THEME,
          allowProposedApi: true,
          scrollback: settings.terminalScrollback,
        });
        (term.options as typeof term.options & { copyOnSelect?: boolean }).copyOnSelect =
          settings.terminalCopyOnSelect;

        fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        term.loadAddon(new WebLinksAddon());

        const searchAddon = new SearchAddon();
        term.loadAddon(searchAddon);
        searchAddonRef.current = searchAddon;

        if (settings.terminalGpuAccel) {
          try {
            webglAddon = new WebglAddon();
            term.loadAddon(webglAddon);
          } catch {
            // WebGL not available, fall back to canvas renderer
          }
        }

        term.open(container!);
        fitAddon.fit();

        setupShellIntegration(term);

        void attachOutputListener();
        void attachEventListener();
        void ensureBackendSession(term.cols, term.rows);

        inputBindingRef.current = bindTerminalInputMode(
          term,
          inputModeRef.current,
          writeToBackend,
          inputBindingRef.current,
        );

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
            }).catch(() => { });
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
            if (triggerAiDrawerToggle(e)) return true;
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
                if (inputMode !== "external") {
                  term?.focus();
                }
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
      if (remoteInitEchoFilterTimer) {
        clearTimeout(remoteInitEchoFilterTimer);
      }
      remoteInitEchoFilter?.releasePending();
      if (contextmenuHandler) {
        container.removeEventListener("contextmenu", contextmenuHandler);
      }
      sendCommandRef.current = null;
      inputBindingRef.current?.dispose();
      inputBindingRef.current = null;
      for (const disposable of disposables) {
        disposable.dispose();
      }
      unlistenOutput?.();
      unlistenEvent?.();
      outputBatcher?.dispose();
      webglAddon?.dispose();
      if (term) {
        term.dispose();
      }
      termRef.current = null;
      searchAddonRef.current = null;
      runtimeRef.current.initTerminal = null;
    };
  }, [sessionId, reconnectKey]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    inputBindingRef.current = bindTerminalInputMode(
      term,
      inputMode,
      (data) => writeToBackendRef.current(data),
      inputBindingRef.current,
    );
  }, [inputMode]);

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
    requestAnimationFrame(() => {
      requestAnimationFrame(() => rt.fitAddon?.fit());
    });
  }, [suspended]);

  useEffect(() => {
    if (!moduleActive || suspended) return;
    const rt = runtimeRef.current;
    if (rt.container && rt.resizeObserver) {
      rt.resizeObserver.observe(rt.container);
    }
    if (!termRef.current && rt.container && rt.initTerminal) {
      const rect = rt.container.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        rt.initTerminal();
      }
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        rt.fitAddon?.fit();
        if (active && inputMode !== "external") {
          termRef.current?.focus();
        }
      });
    });
  }, [moduleActive, active, inputMode, suspended]);

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
