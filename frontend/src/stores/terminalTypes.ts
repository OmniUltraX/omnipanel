import type { Terminal } from "@xterm/xterm";

export type TerminalSessionType = "local" | "remote";

/**
 * 本地 shell 种类，与后端 `ShellKind` 一一对应（serde rename_all = "lowercase"）。
 */
export type LocalShellKind =
  | "bash"
  | "zsh"
  | "powershell"
  | "powershell5"
  | "fish"
  | "cmd"
  | "wsl";

/**
 * 显式指定的本地 shell 规格，与后端 `ShellSpec` 对齐（camelCase）。
 * 仅 type === "local" 的会话使用；远程 SSH 会话始终为 null。
 */
export interface LocalShellSpec {
  kind: LocalShellKind;
  /** 可执行文件路径，null 时按 kind 取默认程序名 */
  path: string | null;
  /** WSL 发行版名称（仅 kind === "wsl" 生效） */
  wslDistro: string | null;
}

/**
 * 可在 UI 中供用户选择的 shell 描述，与后端 `ShellInfo` 对齐。
 */
export interface LocalShellInfo {
  kind: LocalShellKind;
  label: string;
  path: string;
  wslDistro: string | null;
}

export type TerminalSessionInfo = {
  type: TerminalSessionType;
  resourceId: string;
  shellLabel: string;
  cwd: string;
  purpose: string;
  commandPack: string[];
  /** 本地终端显式指定的 shell；远程会话或自动检测时为 null */
  shellSpec?: LocalShellSpec | null;
  /**
   * 远端 tmux 会话名；仅 SSH 远程会话有值。
   *
   * - `ssh_connect` 默认走 `omnipanel-<host>` 会话，会回填此字段；
   * - 用户从远端会话列表「进入」指定会话时，按所选会话名赋值；
   * - 直连模式下为 null（与 transportStore.tmuxSession === null 对齐）。
   *
   * 用于在远端会话治理视图显示「N 个 Tab 正在使用」关联标记，
   * 以及应用重启后恢复 Tab 与远端会话的对应关系。
   */
  tmuxSession?: string | null;
  /**
   * 远端 tmux pane id（数值形式，对应 tmux `%5` 这样的标识）。
   *
   * 关 Tab 时后端只 detach 不 kill 远端 window，进程继续运行；
   * 重连时把 paneId 传回后端 attach 回原 window，从而恢复历史输出
   * 与进行中的耗时进程（下载、编译等）。直连模式或新建 Tab 时为 null。
   */
  tmuxPaneId?: number | null;
};

export type TerminalConnectionStatus = "connecting" | "connected" | "disconnected";

export interface TerminalTab {
  id: string;
  sessionId: string;
  title: string;
  session: TerminalSessionInfo;
  workspaceId?: string;
  workspaceOnly?: boolean;
  backendSessionId: string | null;
  status: TerminalConnectionStatus;
  terminal: Terminal | null;
  createdAt: number;
}

export interface TerminalPane {
  id: string;
  backendSessionId: string | null;
  title: string;
  type: TerminalSessionType;
  resourceId: string;
  shellLabel: string;
  cwd: string;
  purpose: string;
  commandPack: string[];
  terminal: Terminal | null;
  status: TerminalConnectionStatus;
  /** 本地终端显式指定的 shell；远程会话为 null */
  shellSpec?: LocalShellSpec | null;
  /** 远端 tmux 会话名；仅 SSH 远程会话有值，用于关联远端会话治理视图 */
  tmuxSession?: string | null;
  /** 远端 tmux pane id；用于重连时 attach 回原 window 恢复进程与历史 */
  tmuxPaneId?: number | null;
}

export type TerminalTabInput = Omit<
  TerminalTab,
  "backendSessionId" | "status" | "terminal" | "createdAt" | "sessionId"
> & { sessionId?: string };
