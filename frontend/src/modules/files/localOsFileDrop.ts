import { commands, type FileTransferConflictPolicy } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { useConnectionStore } from "../../stores/connectionStore";
import {
  enqueueFileTransfer,
  ensureFileTransferListener,
  useFileManagerStore,
  type FileTransferJobView,
} from "../../stores/fileManagerStore";
import { listDirectory } from "./fileApi";
import { ensureSftpForSsh } from "./syncSshSftp";
import {
  filterEntriesByConflictSkip,
  promptTransferConflictPolicy,
} from "./transferConflict";
import { LOCAL_CONNECTION_ID } from "./utils";

/**
 * 等待指定 batch 的所有传输 job 进入终态（done/error/cancelled）。
 *
 * 用于修复拖拽上传后立即 loadDir 看不到新文件的问题：上传函数现在等
 * batch 真正完成再返回，调用方紧接着刷新列表就能看到结果。
 *
 * 实现说明：
 * - 订阅 `useFileManagerStore` 的 transfers 变化
 * - 初始检查一次，避免 jobs 已是终态时悬挂
 * - 若 batch 在 store 中尚未出现任何 job，继续等（后端可能尚未推送）
 */
function waitForBatchesComplete(batchIds: string[]): Promise<void> {
  return new Promise((resolve) => {
    if (batchIds.length === 0) {
      resolve();
      return;
    }
    const batches = new Set(batchIds);

    const isDone = (state: { transfers: FileTransferJobView[] }) => {
      const relevant = state.transfers.filter((t) => batches.has(t.batchId));
      if (relevant.length === 0) return false;
      return relevant.every(
        (t) => t.state === "done" || t.state === "error" || t.state === "cancelled",
      );
    };

    if (isDone(useFileManagerStore.getState())) {
      resolve();
      return;
    }

    const unsub = useFileManagerStore.subscribe((state) => {
      if (isDone(state)) {
        unsub();
        resolve();
      }
    });
  });
}

export type DroppedLocalFile = {
  name: string;
  /** Tauri / 部分 WebView 会在 File 上挂绝对路径 */
  path?: string;
  file?: File;
  size?: number;
};

/** 拖放项：文件，或可交给传输引擎递归展开的目录。 */
export type DroppedLocalEntry = DroppedLocalFile & {
  kind: "file" | "dir";
};

type FileWithPath = File & { path?: string };

type DataTransferItemWithEntry = DataTransferItem & {
  webkitGetAsEntry?: () => FileSystemEntry | null;
};

/** 是否系统文件拖拽（非应用内 files MIME）。 */
export function isOsFileDrag(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  if (dt.types.includes("Files")) return true;
  return Array.from(dt.items ?? []).some((item) => item.kind === "file");
}

function filePathOf(file: File | null | undefined): string | undefined {
  const path = (file as FileWithPath | null | undefined)?.path?.trim();
  return path || undefined;
}

/** 同步收集顶层文件（不含目录递归；适合本地终端插路径）。 */
export function collectDroppedLocalFiles(dt: DataTransfer): DroppedLocalFile[] {
  const out: DroppedLocalFile[] = [];
  const seen = new Set<string>();

  const add = (file: File | null | undefined) => {
    if (!file?.name) return;
    const path = filePathOf(file);
    const key = path || `name:${file.name}:${file.size}:${file.lastModified}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      name: file.name,
      path,
      file,
      size: Number.isFinite(file.size) ? file.size : undefined,
    });
  };

  if (dt.files?.length) {
    for (const file of Array.from(dt.files)) add(file);
  }
  if (out.length === 0 && dt.items?.length) {
    for (const item of Array.from(dt.items)) {
      if (item.kind === "file") add(item.getAsFile());
    }
  }
  return out;
}

function readAllDirectoryEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    const readBatch = () => {
      reader.readEntries(
        (batch) => {
          if (!batch.length) {
            resolve(all);
            return;
          }
          all.push(...batch);
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

type DropSeed = {
  entry: FileSystemEntry | null;
  file: File | null;
};

/**
 * 必须在 drop/paste 同步阶段调用：先把 Entry/File 句柄抠出来，
 * 再异步遍历（事件结束后 DataTransfer 可能被清空）。
 */
function snapshotDropSeeds(dt: DataTransfer): {
  seeds: DropSeed[];
  fallbackFiles: DroppedLocalFile[];
} {
  const seeds: DropSeed[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== "file") continue;
    const withEntry = item as DataTransferItemWithEntry;
    seeds.push({
      entry: withEntry.webkitGetAsEntry?.() ?? null,
      file: item.getAsFile(),
    });
  }
  return { seeds, fallbackFiles: collectDroppedLocalFiles(dt) };
}

/**
 * 异步收集拖放项。
 * - 顶层目录若带绝对路径：作为 kind=dir，交由后端 expand 递归
 * - 无路径的目录：用 webkitGetAsEntry 在前端递归，展开为相对路径文件列表
 */
export async function collectDroppedLocalEntries(dt: DataTransfer): Promise<DroppedLocalEntry[]> {
  // 同步快照，避免 await 后 DataTransfer 失效
  const { seeds, fallbackFiles } = snapshotDropSeeds(dt);

  if (seeds.some((s) => s.entry)) {
    const out: DroppedLocalEntry[] = [];
    const seen = new Set<string>();

    const pushFile = (name: string, file: File, path?: string) => {
      const key = path || `rel:${name}:${file.size}:${file.lastModified}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        name: name.replace(/\\/g, "/"),
        path,
        file,
        size: Number.isFinite(file.size) ? file.size : undefined,
        kind: "file",
      });
    };

    const walk = async (entry: FileSystemEntry, prefix: string, topFile: File | null) => {
      if (entry.isFile) {
        const file = await entryToFile(entry as FileSystemFileEntry);
        const path = filePathOf(file) || (!prefix ? filePathOf(topFile) : undefined);
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        pushFile(rel, file, path);
        return;
      }
      if (!entry.isDirectory) return;

      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      // 顶层目录且有绝对路径：后端递归展开
      if (!prefix) {
        const dirPath = filePathOf(topFile);
        if (dirPath) {
          const key = `dir:${dirPath}`;
          if (!seen.has(key)) {
            seen.add(key);
            out.push({
              name: entry.name,
              path: dirPath,
              file: topFile ?? undefined,
              kind: "dir",
            });
          }
          return;
        }
      }

      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const children = await readAllDirectoryEntries(reader);
      for (const child of children) {
        await walk(child, rel, null);
      }
    };

    await Promise.all(
      seeds.map(async ({ entry, file }) => {
        if (entry) {
          await walk(entry, "", file);
          return;
        }
        if (file?.name) {
          pushFile(file.name, file, filePathOf(file));
        }
      }),
    );

    if (out.length > 0) return out;
  }

  return fallbackFiles.map((f) => ({ ...f, kind: "file" as const }));
}

/**
 * 将 SSH resourceId / 文件连接 id 解析为传输引擎可用的 destConnectionId。
 * 传输引擎只认 file 连接（含 __local__），不能直接传 SSH id。
 */
export async function resolveFileTransferDestId(connectionId: string): Promise<string> {
  const id = connectionId.trim();
  if (!id) throw new Error("缺少目标连接");
  if (id === LOCAL_CONNECTION_ID) return LOCAL_CONNECTION_ID;

  const conn = useConnectionStore.getState().connections.find((c) => c.id === id);
  if (conn?.kind === "file") return conn.id;
  if (conn?.kind === "ssh") return ensureSftpForSsh(conn.id);

  try {
    return await ensureSftpForSsh(id);
  } catch {
    throw new Error(`无法解析文件传输目标连接: ${id}`);
  }
}

async function loadExistingNames(destConnectionId: string, destDir: string): Promise<string[]> {
  try {
    const listed = await listDirectory(destConnectionId, destDir || "/", null, null, {
      quiet: true,
    });
    return (listed.entries ?? []).map((e) => e.name);
  } catch {
    return [];
  }
}

export type UploadDroppedLocalResult = {
  ok: number;
  fail: number;
  skipped: number;
  lastError: string | null;
  batchIds: string[];
};

/**
 * 上传系统拖入的本地文件/文件夹到目标文件连接目录。
 * - 有绝对路径的文件/目录：enqueue（目录由后端递归展开）
 * - 无路径：读字节走 upload_local_bytes（相对路径名可保留目录结构）
 * - 未指定 conflictPolicy 时：查目标目录同名并弹窗选择
 */
export async function uploadDroppedLocalFiles(opts: {
  files: Array<DroppedLocalFile | DroppedLocalEntry>;
  destConnectionId: string;
  destDir: string;
  conflictPolicy?: FileTransferConflictPolicy;
  /** 已知目标目录文件名；不传则自动 list 一次 */
  existingNames?: Iterable<string>;
}): Promise<UploadDroppedLocalResult> {
  let entries: DroppedLocalEntry[] = opts.files
    .filter((f) => f.name)
    .map((f) => ({
      ...f,
      kind: "kind" in f && (f.kind === "dir" || f.kind === "file") ? f.kind : "file",
    }));

  if (entries.length === 0) {
    return { ok: 0, fail: 0, skipped: 0, lastError: null, batchIds: [] };
  }

  const destConnectionId = await resolveFileTransferDestId(opts.destConnectionId);
  const destDir = opts.destDir || "/";
  await ensureFileTransferListener();

  const existingNames =
    opts.existingNames != null
      ? [...opts.existingNames]
      : await loadExistingNames(destConnectionId, destDir);

  let conflictPolicy = opts.conflictPolicy;
  if (!conflictPolicy) {
    conflictPolicy = await promptTransferConflictPolicy(
      entries.map((e) => e.name),
      existingNames,
    );
  }

  let skipped = 0;
  if (conflictPolicy === "skip") {
    const before = entries.length;
    entries = filterEntriesByConflictSkip(entries, existingNames);
    skipped = before - entries.length;
    if (entries.length === 0) {
      return { ok: 0, fail: 0, skipped, lastError: null, batchIds: [] };
    }
  }

  const batchIds: string[] = [];
  let ok = 0;
  let fail = 0;
  let lastError: string | null = null;

  const pathItems = entries.filter((e) => e.path);
  const byteItems = entries.filter((e) => !e.path);

  if (pathItems.length > 0) {
    try {
      const batchId = await enqueueFileTransfer({
        items: pathItems.map((item) => ({
          connectionId: LOCAL_CONNECTION_ID,
          path: item.path!,
          kind: item.kind,
          name: item.name.replace(/\\/g, "/"),
          size: item.kind === "file" ? (item.size ?? null) : null,
        })),
        destConnectionId,
        destDir,
        op: "copy",
        conflictPolicy,
        forceRoute: null,
        remoteDirectPolicy: "never",
      });
      batchIds.push(batchId);
      ok += pathItems.length;
    } catch (err) {
      // 整批失败时回退逐个，尽量多传
      for (const item of pathItems) {
        try {
          const batchId = await enqueueFileTransfer({
            items: [
              {
                connectionId: LOCAL_CONNECTION_ID,
                path: item.path!,
                kind: item.kind,
                name: item.name.replace(/\\/g, "/"),
                size: item.kind === "file" ? (item.size ?? null) : null,
              },
            ],
            destConnectionId,
            destDir,
            op: "copy",
            conflictPolicy,
            forceRoute: null,
            remoteDirectPolicy: "never",
          });
          batchIds.push(batchId);
          ok += 1;
        } catch (itemErr) {
          fail += 1;
          lastError = itemErr instanceof Error ? itemErr.message : String(itemErr);
        }
      }
      if (ok === 0 && !lastError) {
        lastError = err instanceof Error ? err.message : String(err);
        fail = pathItems.length;
      }
    }
  }

  for (const item of byteItems) {
    if (item.kind === "dir") {
      fail += 1;
      lastError = `无法读取文件夹内容: ${item.name}`;
      continue;
    }
    try {
      if (!item.file) {
        throw new Error(`无法读取文件: ${item.name}`);
      }
      const buffer = await item.file.arrayBuffer();
      const bytes = Array.from(new Uint8Array(buffer));
      const batchId = await unwrapCommand(
        commands.fileTransferUploadLocalBytes(
          item.name.replace(/\\/g, "/"),
          bytes,
          destConnectionId,
          destDir,
          conflictPolicy,
        ),
      );
      batchIds.push(batchId);
      ok += 1;
    } catch (err) {
      fail += 1;
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  // 等待所有已入队 batch 真正完成（done/error/cancelled）再返回，
  // 这样调用方紧接着的 loadDir 才能看到刚上传的新文件。
  // 失败的（未推入 batchIds 的）不影响等待。
  await waitForBatchesComplete(batchIds);

  return { ok, fail, skipped, lastError, batchIds };
}

/** 本地终端插入路径：有绝对路径用绝对路径，否则用文件名（仅顶层）。 */
export function formatDroppedLocalPaths(files: DroppedLocalFile[]): string {
  const paths = files
    .filter((f) => f.name)
    .map((f) => f.path || f.name)
    .filter(Boolean);
  if (paths.length === 0) return "";
  return paths.map((p) => `"${p.replace(/"/g, '\\"')}"`).join(" ");
}
