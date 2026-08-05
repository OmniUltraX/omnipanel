import type { FileClipboardItem } from "../../stores/filesClipboardStore";
import { LOCAL_CONNECTION_ID } from "./utils";

type FileWithPath = File & { path?: string };

/** 无绝对路径时按相对路径上传（保留文件夹结构）。 */
export type OsDropByteFile = {
  relativePath: string;
  file: File;
};

export type OsDropCollectResult = {
  /** 带本机绝对路径的项（含目录），可直接入传输队列 */
  pathItems: FileClipboardItem[];
  /** 仅有 File 对象时的回退（通常无 path 的 WebView） */
  byteFiles: OsDropByteFile[];
};

export function hasOsFileDrag(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  const types = Array.from(dataTransfer.types ?? []);
  if (types.includes("Files")) return true;
  return Array.from(dataTransfer.items ?? []).some((item) => item.kind === "file");
}

function basenameOf(pathOrName: string): string {
  const parts = pathOrName.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || pathOrName;
}

function readAllDirectoryEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const acc: FileSystemEntry[] = [];
    const readBatch = () => {
      reader.readEntries(
        (batch) => {
          if (!batch.length) {
            resolve(acc);
            return;
          }
          acc.push(...batch);
          readBatch();
        },
        reject,
      );
    };
    readBatch();
  });
}

function entryToFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(resolve, reject);
  });
}

async function collectDirectoryBytes(
  dir: FileSystemDirectoryEntry,
  prefix: string,
): Promise<OsDropByteFile[]> {
  const reader = dir.createReader();
  const entries = await readAllDirectoryEntries(reader);
  const out: OsDropByteFile[] = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory) {
      out.push(...(await collectDirectoryBytes(entry as FileSystemDirectoryEntry, rel)));
    } else if (entry.isFile) {
      const file = await entryToFile(entry as FileSystemFileEntry);
      out.push({ relativePath: rel.replace(/\\/g, "/"), file });
    }
  }
  return out;
}

/**
 * 从系统拖放 DataTransfer 收集本机路径 / File 回退项。
 * Tauri WebView 下 File 通常带 `path`；目录用 webkitGetAsEntry 区分。
 */
export async function collectOsDropItems(dataTransfer: DataTransfer): Promise<OsDropCollectResult> {
  const pathItems: FileClipboardItem[] = [];
  const byteFiles: OsDropByteFile[] = [];
  const seenPaths = new Set<string>();

  const pushPathItem = (absPath: string, name: string, isDir: boolean, size?: number) => {
    const key = absPath.replace(/\\/g, "/").toLowerCase();
    if (seenPaths.has(key)) return;
    seenPaths.add(key);
    pathItems.push({
      connectionId: LOCAL_CONNECTION_ID,
      path: absPath,
      name: name || basenameOf(absPath),
      kind: isDir ? "dir" : "file",
      size: isDir ? null : (size ?? null),
    });
  };

  const items = Array.from(dataTransfer.items ?? []);
  if (items.length > 0) {
    for (const item of items) {
      if (item.kind !== "file") continue;
      const entry =
        typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null;
      const file = item.getAsFile() as FileWithPath | null;
      const absPath = file?.path?.trim();

      if (absPath) {
        const isDir = Boolean(entry?.isDirectory);
        pushPathItem(absPath, file?.name || basenameOf(absPath), isDir, file?.size);
        continue;
      }

      if (entry?.isDirectory) {
        byteFiles.push(
          ...(await collectDirectoryBytes(entry as FileSystemDirectoryEntry, entry.name)),
        );
        continue;
      }

      if (file?.name) {
        byteFiles.push({ relativePath: file.name, file });
      }
    }
    return { pathItems, byteFiles };
  }

  for (const file of Array.from(dataTransfer.files ?? []) as FileWithPath[]) {
    if (!file?.name) continue;
    const absPath = file.path?.trim();
    if (absPath) {
      pushPathItem(absPath, file.name, false, file.size);
    } else {
      byteFiles.push({ relativePath: file.name, file });
    }
  }

  return { pathItems, byteFiles };
}
