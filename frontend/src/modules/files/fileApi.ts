import { commands, type Connection, type FileIndexProgress, type FileIndexSearchResult, type FileIndexStatus, type FileListDirResult, type FileManagerConnectionInfo, type OmniError_Serialize } from "../../ipc/bindings";
import { fmtError } from "./utils";

function ipcErrorToError(error: OmniError_Serialize): Error {
  const message = error.cause ? `${error.message}（${error.cause}）` : error.message;
  const err = new Error(message);
  Object.assign(err, { code: error.code, cause: error.cause ?? null });
  return err;
}

async function unwrap<T>(
  res: { status: string; data?: T; error?: OmniError_Serialize },
  debugContext?: Record<string, unknown>,
): Promise<T> {
  if (res.status === "ok" && res.data !== undefined) return res.data;
  if (res.error) {
    console.error("[files] IPC error:", {
      ...debugContext,
      code: res.error.code,
      message: res.error.message,
      cause: res.error.cause ?? null,
    });
    throw ipcErrorToError(res.error);
  }
  console.error("[files] IPC error: unknown failure", debugContext);
  throw new Error("请求失败");
}

export async function listFileConnections(): Promise<FileManagerConnectionInfo[]> {
  return unwrap(await commands.fileListConnections());
}

export async function listDirectory(
  connectionId: string,
  path: string,
  search?: string | null,
  continuationToken?: string | null,
): Promise<FileListDirResult> {
  const query = search?.trim() ? search.trim() : null;
  const token = continuationToken?.trim() ? continuationToken.trim() : null;
  return unwrap(await commands.fileListDir(connectionId, path, query, token), {
    op: "fileListDir",
    connectionId,
    path,
    search: query,
    continuationToken: token,
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

export async function deleteRemote(connectionId: string, path: string): Promise<void> {
  await unwrap(await commands.fileDelete(connectionId, path));
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

export type { FileIndexProgress, FileIndexStatus };

export { fmtError };
