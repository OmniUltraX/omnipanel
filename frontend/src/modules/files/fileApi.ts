import { commands, type Connection, type FileIndexSearchResult, type FileIndexStatus, type FileListDirResult, type FileManagerConnectionInfo } from "../../ipc/bindings";
import { unwrapCommandResult, type CommandResult, type IpcErrorLike } from "../../ipc/result";
import { fmtError } from "./utils";

export type FileIndexProgress = {
  connectionId: string;
  status: "building" | "done" | "failed";
  indexedCount?: number | null;
  error?: string | null;
};

/** files 模块：已 await 的 CommandResult + 可选调试上下文。 */
function unwrap<T>(
  res: CommandResult<T, IpcErrorLike>,
  debugContext?: Record<string, unknown> & { quiet?: boolean },
): T {
  return unwrapCommandResult(res, {
    quiet: debugContext?.quiet,
    debugContext,
    logLabel: "[files]",
  });
}

export async function listFileConnections(): Promise<FileManagerConnectionInfo[]> {
  return unwrap(await commands.fileListConnections());
}

export async function listDirectory(
  connectionId: string,
  path: string,
  search?: string | null,
  continuationToken?: string | null,
  options?: { quiet?: boolean },
): Promise<FileListDirResult> {
  const query = search?.trim() ? search.trim() : null;
  const token = continuationToken?.trim() ? continuationToken.trim() : null;
  return unwrap(await commands.fileListDir(connectionId, path, query, token), {
    op: "fileListDir",
    connectionId,
    path,
    search: query,
    continuationToken: token,
    quiet: options?.quiet,
  });
}

export async function saveFileConnection(connection: Connection, secret: string | null): Promise<Connection> {
  return unwrap(await commands.fileSaveConnection(connection, secret));
}

export async function testFileConnection(connectionId: string): Promise<string> {
  return unwrap(await commands.fileTestConnection(connectionId));
}

export async function mkdirRemote(connectionId: string, path: string): Promise<void> {
  await unwrap(await commands.fileMkdir(connectionId, path));
}

export async function renameRemote(connectionId: string, oldPath: string, newPath: string): Promise<void> {
  await unwrap(await commands.fileRename(connectionId, oldPath, newPath));
}

export async function deleteRemote(
  connectionId: string,
  path: string,
  entryKind?: string | null,
): Promise<void> {
  await unwrap(await commands.fileDelete(connectionId, path, entryKind ?? null));
}

export async function uploadRemote(connectionId: string, path: string, data: number[]): Promise<void> {
  await unwrap(await commands.fileUploadFile(connectionId, path, data));
}

export async function downloadRemote(connectionId: string, remotePath: string, localPath: string): Promise<void> {
  await unwrap(await commands.fileDownloadFile(connectionId, remotePath, localPath));
}

export async function readRemotePreview(connectionId: string, path: string, maxBytes = 512 * 1024): Promise<number[]> {
  return unwrap(await commands.fileReadFile(connectionId, path, maxBytes));
}

export async function loadQuickPaths() {
  return unwrap(await commands.fileLocalQuickPaths());
}

export async function loadLocalSystemInfo() {
  return unwrap(await commands.fileLocalSystemInfo());
}

export async function searchS3Files(
  connectionId: string,
  query: string,
  continuationToken?: string | null,
): Promise<FileListDirResult> {
  const q = query.trim();
  const token = continuationToken?.trim() ? continuationToken.trim() : null;
  return unwrap(await commands.fileS3Search(connectionId, q, token), {
    op: "fileS3Search",
    connectionId,
    query: q,
    continuationToken: token,
  });
}

export async function buildFileIndex(connectionId: string): Promise<FileIndexStatus> {
  return unwrap(await commands.fileIndexBuild(connectionId), { op: "fileIndexBuild", connectionId });
}

export async function searchFileIndex(
  connectionId: string,
  query: string,
  limit = 100,
): Promise<FileIndexSearchResult[]> {
  return unwrap(await commands.fileIndexSearch(connectionId, query, limit), {
    op: "fileIndexSearch",
    connectionId,
    query,
  });
}

export async function getFileIndexStatus(connectionId: string): Promise<FileIndexStatus> {
  return unwrap(await commands.fileIndexStatus(connectionId), { op: "fileIndexStatus", connectionId });
}

export async function clearFileIndex(connectionId: string): Promise<void> {
  await unwrap(await commands.fileIndexClear(connectionId), { op: "fileIndexClear", connectionId });
}

export async function cancelFileIndex(connectionId: string): Promise<void> {
  await unwrap(await commands.fileIndexCancel(connectionId), { op: "fileIndexCancel", connectionId });
}

export type { FileIndexStatus };

export { fmtError };
