/**
 * 终端输出中文件路径识别 + 解析。
 * 与 lsListing/commandBar 中已有路径逻辑保持一致。
 */

import type { TerminalSessionType } from "../../stores/terminalStore";

/** 终端输出中可能出现的"文件路径 token"匹配规则。
 *  允许绝对路径（/xxx）、home 展开（~/xxx）、相对路径（./xxx 或 ../xxx）、
 *  Windows 风格（C:\xxx、C:/xxx）、以及常见可执行/文件路径。
 *
 *  故意保守：只匹配"看起来确实像路径"的 token，避免把普通英文误判成链接。
 */
const FILE_PATH_RE =
  /(?:~|\.{1,2})?\/[\w./\-_]+|\/[\w.\-_]+|[A-Za-z]:[\\/][\w./\\:\-_ ]*|[A-Za-z]:\\[\w.\\\-_ ]+/g;

export interface DetectedFilePath {
  /** 文本 token 原值（用于在 buffer 中定位） */
  text: string;
  /** 起点列（相对 buffer 行） */
  start: number;
  /** 终点列（不含） */
  end: number;
  /** 解析后的绝对路径（推断） */
  absolutePath: string;
  /** 文件名（用于判断预览类型） */
  name: string;
}

/** 简易 path 解析：处理 `.` / `..`，不要求 node:path */
function joinPath(base: string, relative: string): string {
  if (!base) return relative;
  if (base.startsWith("~")) {
    // 不展开 ~，交给后端或 stat
    return base;
  }
  if (relative.startsWith("/") || /^[A-Za-z]:[\\/]/.test(relative)) {
    return relative;
  }
  const isWindows = /^[A-Za-z]:/.test(base) || base.includes("\\");
  const sep = isWindows ? "\\" : "/";
  const stack = base.replace(/[\\/]+$/, "").split(/[\\/]/);
  for (const seg of relative.split(/[\\/]/)) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (stack.length > 1) stack.pop();
      continue;
    }
    stack.push(seg);
  }
  return stack.join(sep) || sep;
}

function basename(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx < 0 ? path : path.slice(idx + 1);
}

/** 展开 `~` 到已知 home（避免在远端 session 把本地 home 误用） */
function expandTilde(
  raw: string,
  sessionType: TerminalSessionType,
  remoteHome: string | null,
): string {
  if (!raw.startsWith("~")) return raw;
  const home = sessionType === "local" ? remoteHome : remoteHome;
  if (!home) return raw;
  if (raw === "~") return home;
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    return joinPath(home, raw.slice(2));
  }
  return raw;
}

export interface ResolveFilePathInput {
  /** 从终端输出抓到的 token */
  text: string;
  /** 终端当前 cwd（已 normalize 过） */
  cwd: string;
  /** local / remote */
  sessionType: TerminalSessionType;
  /** 远端 home（local 用本地 home） */
  remoteHome: string | null;
}

export function resolveDetectedFilePath({
  text,
  cwd,
  sessionType,
  remoteHome,
}: ResolveFilePathInput): DetectedFilePath | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  // 过滤过短或纯点号
  if (trimmed.length < 2) return null;
  // 必须包含文件名前缀（字母或数字）才认定为路径
  if (!/[A-Za-z0-9]/.test(trimmed)) return null;

  const expanded = expandTilde(trimmed, sessionType, remoteHome);
  const absolutePath =
    expanded.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(expanded) ||
    expanded.startsWith("~")
      ? expanded
      : joinPath(cwd, expanded);

  return {
    text: trimmed,
    start: 0,
    end: trimmed.length,
    absolutePath,
    name: basename(absolutePath),
  };
}

/** 在 buffer 行的纯文本中找出所有"文件路径"区间 */
export function detectFilePathRanges(
  line: string,
): Array<{ text: string; start: number; end: number }> {
  const out: Array<{ text: string; start: number; end: number }> = [];
  FILE_PATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FILE_PATH_RE.exec(line)) !== null) {
    const raw = m[0];
    const start = m.index;
    const end = start + raw.length;
    // 排除纯斜杠或纯点
    if (!/[A-Za-z0-9]/.test(raw)) continue;
    // 排除像 `://` 这种协议前缀（url）
    if (/^[A-Za-z]+:\/\//.test(raw)) continue;
    out.push({ text: raw, start, end });
  }
  return out;
}
