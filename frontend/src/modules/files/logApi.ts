import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  commands,
  type LogLine,
  type LogSearchHit,
  type LogSessionInfo,
  type LogTailChunk,
  type LogTailHandle,
} from "../../ipc/bindings";
import { unwrapCommandResult, type CommandResult, type IpcErrorLike } from "../../ipc/result";

function unwrap<T>(res: CommandResult<T, IpcErrorLike>, op: string): T {
  return unwrapCommandResult(res, { logLabel: "[logViewer]", debugContext: { op } });
}

/** 打开日志会话：探测文件大小与总行数预估。 */
export async function openLogSession(id: string, path: string): Promise<LogSessionInfo> {
  return unwrap(await commands.sftpLogOpen(id, path), "sftpLogOpen");
}

/** 按行号范围读取（虚拟滚动按需切片，1-based）。 */
export async function readLogLines(
  id: string,
  path: string,
  startLine: number,
  endLine: number,
): Promise<LogLine[]> {
  return unwrap(await commands.sftpLogReadLines(id, path, startLine, endLine), "sftpLogReadLines");
}

/**
 * 读取文件末尾 N 行（tail -n N，反向 seek 不扫描整个文件）。
 * 用于首屏末尾预览，比 sed -n 'X,Yp' 快 30x（1GB 文件 12ms vs 370ms）。
 * 行号基于 totalLinesHint 推算：若 hint 为 null，行号从 1 开始（内容仍是末尾 N 行）。
 */
export async function readLogTailInitial(
  id: string,
  path: string,
  nLines: number,
  totalLinesHint: number | null,
): Promise<LogLine[]> {
  return unwrap(
    await commands.sftpLogTailInitial(id, path, nLines, totalLinesHint),
    "sftpLogTailInitial",
  );
}

/** 搜索日志（grep -n），返回命中行列表。 */
export async function searchLog(
  id: string,
  path: string,
  pattern: string,
  options?: {
    isRegex?: boolean;
    maxResults?: number | null;
    contextBefore?: number | null;
    contextAfter?: number | null;
  },
): Promise<LogSearchHit[]> {
  const isRegex = options?.isRegex ?? false;
  const maxResults = options?.maxResults ?? null;
  const contextBefore = options?.contextBefore ?? null;
  const contextAfter = options?.contextAfter ?? null;
  return unwrap(
    await commands.sftpLogSearch(
      id,
      path,
      pattern,
      isRegex,
      maxResults,
      contextBefore,
      contextAfter,
    ),
    "sftpLogSearch",
  );
}

/** 开始实时跟踪。返回 token 与 unsubscribe（用于停止监听事件）。 */
export async function startLogTail(
  id: string,
  path: string,
  linesAfter: number | null,
  onChunk: (chunk: LogTailChunk) => void,
): Promise<{ handle: LogTailHandle; unsubscribe: UnlistenFn | null }> {
  const handle = unwrap(await commands.sftpLogTailStart(id, path, linesAfter), "sftpLogTailStart");
  const eventName = `sftp-log-tail-${handle.token}`;
  let unlisten: UnlistenFn | null = null;
  try {
    unlisten = await listen<LogTailChunk>(eventName, (e) => onChunk(e.payload));
  } catch {
    // listen 失败不阻塞，但调用方收不到事件
    unlisten = null;
  }
  return { handle, unsubscribe: unlisten };
}

/** 停止实时跟踪。 */
export async function stopLogTail(token: string): Promise<void> {
  await unwrap(await commands.sftpLogTailStop(token), "sftpLogTailStop");
}
