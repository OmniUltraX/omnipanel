import { commands, type FileEntry } from "../../ipc/bindings";
import { unwrapCommandResult } from "../../ipc/result";
import { listDirectory, mkdirRemote, uploadRemote } from "./fileApi";
import {
  joinRemotePath,
  LOCAL_CONNECTION_ID,
  parentPath,
  sortFileEntries,
} from "./utils";

export type FilePreviewTreeSession = {
  sessionType: "local" | "remote";
  /** 本地为 LOCAL_CONNECTION_ID；远端预览多为 SSH resourceId */
  connectionId: string;
  resourceId?: string | null;
};

function pathProtocol(session: FilePreviewTreeSession): "local" | "remote" {
  return session.sessionType === "local" ? "local" : "remote";
}

export function previewTreeParentPath(
  path: string,
  session: FilePreviewTreeSession,
): string {
  return parentPath(path, pathProtocol(session));
}

export function previewTreeJoinPath(
  base: string,
  name: string,
  session: FilePreviewTreeSession,
): string {
  return joinRemotePath(base, name, pathProtocol(session));
}

export function previewTreeIsRoot(
  path: string,
  session: FilePreviewTreeSession,
): boolean {
  const parent = previewTreeParentPath(path, session);
  return parent === path;
}

/** 判断 path 是否位于 root 之下（含自身）。 */
export function previewTreePathWithin(
  root: string,
  path: string,
  session: FilePreviewTreeSession,
): boolean {
  if (!root) return false;
  if (path === root) return true;
  const protocol = pathProtocol(session);
  if (protocol === "local") {
    const sep = root.includes("\\") ? "\\" : "/";
    const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
    return path.startsWith(prefix);
  }
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return path.startsWith(prefix);
}

function mapSftpEntries(dir: string, entries: { name: string; isDir: boolean; size: number | null }[]): FileEntry[] {
  const mapped: FileEntry[] = [];
  for (const entry of entries) {
    if (!entry.name || entry.name === "." || entry.name === "..") continue;
    const path =
      !dir || dir === "/"
        ? `/${entry.name}`
        : `${dir.replace(/\/+$/, "")}/${entry.name}`;
    mapped.push({
      name: entry.name,
      path,
      kind: entry.isDir ? "dir" : "file",
      size: entry.size,
      modified: null,
      permissions: null,
    });
  }
  return sortFileEntries(mapped);
}

export async function listPreviewTreeDir(
  session: FilePreviewTreeSession,
  path: string,
): Promise<FileEntry[]> {
  if (session.sessionType === "local") {
    const result = await listDirectory(LOCAL_CONNECTION_ID, path || "/", null, null, {
      quiet: true,
    });
    return sortFileEntries(result.entries);
  }

  const resourceId = session.resourceId ?? session.connectionId;
  if (!resourceId) return [];
  const res = await commands.sftpList(resourceId, path || "/");
  const entries = unwrapCommandResult(res, {
    quiet: true,
    logLabel: "[file-preview-tree]",
    debugContext: { op: "sftpList", resourceId, path },
  });
  return mapSftpEntries(path || "/", entries);
}

export async function mkdirPreviewTree(
  session: FilePreviewTreeSession,
  path: string,
): Promise<void> {
  if (session.sessionType === "local") {
    await mkdirRemote(LOCAL_CONNECTION_ID, path);
    return;
  }
  const resourceId = session.resourceId ?? session.connectionId;
  if (!resourceId) throw new Error("missing resourceId");
  unwrapCommandResult(await commands.sftpMkdir(resourceId, path), {
    logLabel: "[file-preview-tree]",
    debugContext: { op: "sftpMkdir", resourceId, path },
  });
}

/** 创建空文件（覆盖写）。 */
export async function createEmptyPreviewTreeFile(
  session: FilePreviewTreeSession,
  path: string,
): Promise<void> {
  if (session.sessionType === "local") {
    await uploadRemote(LOCAL_CONNECTION_ID, path, []);
    return;
  }
  const resourceId = session.resourceId ?? session.connectionId;
  if (!resourceId) throw new Error("missing resourceId");
  unwrapCommandResult(await commands.sftpUpload(resourceId, path, []), {
    logLabel: "[file-preview-tree]",
    debugContext: { op: "sftpUpload", resourceId, path },
  });
}
