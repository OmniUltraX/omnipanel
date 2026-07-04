import type { FileEntry, FileManagerConnectionInfo } from "../../ipc/bindings";
import { parentLocalPath } from "./localFilesystem";

export const LOCAL_CONNECTION_ID = "__local__";

export type FileSidebarProtocolSection = "local" | "s3" | "remote";

export type FileConnectionsByProtocol = Record<FileSidebarProtocolSection, FileManagerConnectionInfo[]>;

export function fileSidebarSectionForProtocol(protocol: string): FileSidebarProtocolSection {
  if (protocol === "local") return "local";
  if (protocol === "s3") return "s3";
  return "remote";
}

export function groupFileConnectionsByProtocol(
  connections: FileManagerConnectionInfo[],
): FileConnectionsByProtocol {
  const grouped: FileConnectionsByProtocol = { local: [], s3: [], remote: [] };
  for (const conn of connections) {
    grouped[fileSidebarSectionForProtocol(conn.protocol)].push(conn);
  }
  return grouped;
}

/** 目录项排序：文件夹在前，同类型按名称（不区分大小写）。 */
export function sortFileEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    const ad = a.kind === "dir";
    const bd = b.kind === "dir";
    if (ad !== bd) return ad ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

const GRID_IMAGE_EXTENSIONS = new Set(["svg", "png", "jpg", "jpeg", "webp"]);

export function isGridImageFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return GRID_IMAGE_EXTENSIONS.has(ext);
}

export function imageMimeType(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "svg":
      return "image/svg+xml";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes == null || bytes === 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** 预览读取时传给后端的 max_bytes，与设置中的预览阈值一致。 */
export function resolvePreviewReadMaxBytes(
  _fileSize: number | null | undefined,
  thresholdBytes: number,
): number {
  return thresholdBytes;
}

export function exceedsPreviewThreshold(
  fileSize: number | null | undefined,
  thresholdBytes: number,
): boolean {
  return fileSize != null && fileSize > thresholdBytes;
}

/**
 * 大文件策略分级：
 *  - `normal`: <= 1MB —— 直接读完整渲染
 *  - `truncated`: 1MB - 10MB —— 读前 1MB 截断预览，banner 提示 + 强制按钮
 *  - `blocked`: > 10MB —— 阻止预览，banner 提示用户用外部工具
 *  - `unknown`: fileSize 未知 —— normal
 */
export type LargeFileStrategy = "normal" | "truncated" | "blocked" | "unknown";

/** 强制预览的"完整读"上限：读整个 10MB 文件（不切分） */
export const FORCE_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;

export function classifyLargeFile(
  fileSize: number | null | undefined,
  thresholdBytes: number,
): LargeFileStrategy {
  if (fileSize == null) return "unknown";
  if (fileSize > FORCE_PREVIEW_MAX_BYTES) return "blocked";
  if (fileSize > thresholdBytes) return "truncated";
  return "normal";
}

/** 计算预览文本中行数；用于截断 banner 显示 "文件前 X 行已加载" */
export function countPreviewLines(text: string | null | undefined): number {
  if (!text) return 0;
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++;
  }
  return count;
}

export function formatFileTime(ts: number | null | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

export function fileTypeLabel(entry: FileEntry): string {
  if (entry.kind === "dir") return "文件夹";
  const ext = entry.name.includes(".") ? entry.name.split(".").pop()?.toUpperCase() : "";
  return ext || "文件";
}

export function joinRemotePath(base: string, name: string, protocol: string): string {
  if (protocol === "s3") {
    const prefix = base.endsWith("/") ? base : base ? `${base}/` : "";
    return `${prefix}${name}`;
  }
  if (protocol === "local") {
    const sep = base.includes("\\") ? "\\" : "/";
    if (!base || base === sep) return `${sep}${name}`;
    return `${base.replace(/[\\/]+$/, "")}${sep}${name}`;
  }
  if (base === "/" || !base) return `/${name}`;
  return `${base.replace(/\/+$/, "")}/${name}`;
}

export function parentPath(path: string, protocol: string): string {
  if (protocol === "local") {
    return parentLocalPath(path);
  }
  if (protocol === "s3") {
    const trimmed = path.replace(/\/+$/, "");
    const idx = trimmed.lastIndexOf("/");
    if (idx <= 0) return "";
    return `${trimmed.slice(0, idx + 1)}`;
  }
  if (path === "/") return "/";
  const parent = path.split("/").slice(0, -1).join("/");
  return parent || "/";
}

export function isPathNotFoundError(e: unknown): boolean {
  const msg = fmtError(e).toLowerCase();
  return (
    msg.includes("no such file") ||
    msg.includes("no such directory") ||
    msg.includes("enoent") ||
    msg.includes("找不到") ||
    (msg.includes("不存在") &&
      (msg.includes("目录") || msg.includes("路径") || msg.includes("file")))
  );
}

export function fmtError(e: unknown): string {
  if (e instanceof Error) {
    const extra = e as Error & { code?: unknown; cause?: unknown };
    if (typeof extra.cause === "string" && extra.cause && !e.message.includes(extra.cause)) {
      return `${e.message}（${extra.cause}）`;
    }
    return e.message;
  }
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const err = e as Record<string, unknown>;
    const message = typeof err.message === "string" ? err.message : null;
    const cause = typeof err.cause === "string" ? err.cause : null;
    if (message && cause && !message.includes(cause)) return `${message}（${cause}）`;
    if (message) return message;
  }
  return String(e);
}
