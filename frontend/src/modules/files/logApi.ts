import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  commands,
  type LogLine,
  type LogSearchHit,
  type LogSessionInfo,
  type LogTailHandle,
} from "../../ipc/bindings";
import { unwrapCommandResult, type CommandResult, type IpcErrorLike } from "../../ipc/result";

/** 跟踪事件 payload（与后端 LogTailChunk 对齐）。 */
export type LogTailChunk = {
  token: string;
  lines: string[];
  exitCode?: number | null;
  error?: string | null;
};

export type LogBackendKind = "ssh" | "local";

export type LogBackend = {
  kind: LogBackendKind;
  /** SSH 资源 id；local 可为空 */
  id?: string;
};

function unwrap<T>(res: CommandResult<T, IpcErrorLike>, op: string): T {
  return unwrapCommandResult(res, { logLabel: "[logViewer]", debugContext: { op } });
}

export function sshLogBackend(sshId: string): LogBackend {
  return { kind: "ssh", id: sshId };
}

export function localLogBackend(): LogBackend {
  return { kind: "local" };
}

/** 打开日志会话：探测文件大小与总行数预估。 */
export async function openLogSession(backend: LogBackend, path: string): Promise<LogSessionInfo> {
  if (backend.kind === "local") {
    return unwrap(await commands.localLogOpen(path), "localLogOpen");
  }
  return unwrap(await commands.sftpLogOpen(backend.id!, path), "sftpLogOpen");
}

/** 按行号范围读取（虚拟滚动按需切片，1-based）。 */
export async function readLogLines(
  backend: LogBackend,
  path: string,
  startLine: number,
  endLine: number,
): Promise<LogLine[]> {
  if (backend.kind === "local") {
    return unwrap(await commands.localLogReadLines(path, startLine, endLine), "localLogReadLines");
  }
  return unwrap(
    await commands.sftpLogReadLines(backend.id!, path, startLine, endLine),
    "sftpLogReadLines",
  );
}

/**
 * 读取文件末尾 N 行。
 * 行号基于 totalLinesHint 推算：若 hint 为 null，行号从 1 开始（内容仍是末尾 N 行）。
 */
export async function readLogTailInitial(
  backend: LogBackend,
  path: string,
  nLines: number,
  totalLinesHint: number | null,
): Promise<LogLine[]> {
  if (backend.kind === "local") {
    return unwrap(
      await commands.localLogTailInitial(path, nLines, totalLinesHint),
      "localLogTailInitial",
    );
  }
  return unwrap(
    await commands.sftpLogTailInitial(backend.id!, path, nLines, totalLinesHint),
    "sftpLogTailInitial",
  );
}

/** 搜索日志，返回命中行列表。 */
export async function searchLog(
  backend: LogBackend,
  path: string,
  pattern: string,
  options?: {
    isRegex?: boolean;
    maxResults?: number | null;
    contextBefore?: number | null;
    contextAfter?: number | null;
    reverse?: boolean;
    beforeLine?: number | null;
    afterLine?: number | null;
    totalLinesHint?: number | null;
    skipMatches?: number | null;
  },
): Promise<LogSearchHit[]> {
  const opts = {
    isRegex: options?.isRegex ?? false,
    maxResults: options?.maxResults ?? null,
    contextBefore: options?.contextBefore ?? null,
    contextAfter: options?.contextAfter ?? null,
    reverse: options?.reverse ?? false,
    beforeLine: options?.beforeLine ?? null,
    afterLine: options?.afterLine ?? null,
    totalLinesHint: options?.totalLinesHint ?? null,
    skipMatches: options?.skipMatches ?? null,
  };
  if (backend.kind === "local") {
    return unwrap(await commands.localLogSearch(path, pattern, opts), "localLogSearch");
  }
  return unwrap(await commands.sftpLogSearch(backend.id!, path, pattern, opts), "sftpLogSearch");
}

/** 开始实时跟踪。 */
export async function startLogTail(
  backend: LogBackend,
  path: string,
  linesAfter: number | null,
  onChunk: (chunk: LogTailChunk) => void,
): Promise<{ handle: LogTailHandle; unsubscribe: UnlistenFn | null }> {
  const handle =
    backend.kind === "local"
      ? unwrap(await commands.localLogTailStart(path, linesAfter), "localLogTailStart")
      : unwrap(await commands.sftpLogTailStart(backend.id!, path, linesAfter), "sftpLogTailStart");
  const eventName =
    backend.kind === "local" ? `local-log-tail-${handle.token}` : `sftp-log-tail-${handle.token}`;
  let unlisten: UnlistenFn | null = null;
  try {
    unlisten = await listen<LogTailChunk>(eventName, (e) => onChunk(e.payload));
  } catch {
    unlisten = null;
  }
  return { handle, unsubscribe: unlisten };
}

/** 停止实时跟踪。 */
export async function stopLogTail(backend: LogBackend, token: string): Promise<void> {
  if (backend.kind === "local") {
    await unwrap(await commands.localLogTailStop(token), "localLogTailStop");
    return;
  }
  await unwrap(await commands.sftpLogTailStop(token), "sftpLogTailStop");
}

/** @deprecated 使用 openLogSession(sshLogBackend(id), path) */
export async function openLogSessionBySshId(id: string, path: string): Promise<LogSessionInfo> {
  return openLogSession(sshLogBackend(id), path);
}
