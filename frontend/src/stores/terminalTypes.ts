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
}

export type TerminalTabInput = Omit<
  TerminalTab,
  "backendSessionId" | "status" | "terminal" | "createdAt" | "sessionId"
> & { sessionId?: string };
