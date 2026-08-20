/**
 * 终端输出中文件路径识别 + 解析。
 * 与 lsListing/commandBar 中已有路径逻辑保持一致。
 */

import type { TerminalSessionType } from "../../stores/terminalStore";
import { shouldRouteInputToAi } from "./commandInputRouting";
import { promptPrefixEndIndex, stripShellPromptPrefix } from "./passthroughAi/screenLine";

/** 带斜杠 / 盘符的路径 token。故意比裸文件名宽松一档，仍排除 URL。 */
const FILE_PATH_RE =
  /(?:~|\.{1,2})?\/[^\s]+|(?:[A-Za-z]:[\\/])[^\s]+/g;

const BARE_NAME_RE = /[^\s]+/g;

const LS_F_FILE_SUFFIX = new Set(["*", "@", "|", "="]);

export type PathLinkKind = "dir" | "file";
export type PathLinkAction = "preview" | "cd" | "cd-blocked";

export function decidePathLinkAction(kind: PathLinkKind, canSendCd: boolean): PathLinkAction {
  if (kind === "dir") return canSendCd ? "cd" : "cd-blocked";
  return "preview";
}

export function isXtermMouseTrackingOn(term: { modes?: { mouseTrackingMode?: string } } | null): boolean {
  const mode = term?.modes?.mouseTrackingMode;
  return Boolean(mode && mode !== "none");
}

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

export interface ClassifiedPathLink extends DetectedFilePath {
  kind: PathLinkKind;
}

export type PathListingHint = { name: string; isDir: boolean };

export interface ClassifyLinePathLinksInput {
  line: string;
  cwd: string;
  sessionType: TerminalSessionType;
  remoteHome: string | null;
  listing: readonly PathListingHint[] | null;
  isDirectoryColor?: (start: number, end: number) => boolean;
}

/** 简易 path 解析：处理 `.` / `..`，不要求 node:path */
function joinPath(base: string, relative: string): string {
  if (!base) return relative;
  if (base.startsWith("~")) {
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

function expandTilde(
  raw: string,
  sessionType: TerminalSessionType,
  remoteHome: string | null,
): string {
  void sessionType;
  if (!raw.startsWith("~")) return raw;
  const home = remoteHome;
  if (!home) return raw;
  if (raw === "~") return home;
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    return joinPath(home, raw.slice(2));
  }
  return raw;
}

function trimTrailingPunctuation(raw: string): string {
  return raw.replace(/[,;:)+]+$/u, "");
}

function unwrapPathToken(raw: string): string {
  return trimTrailingPunctuation(raw.trim().replace(/^['"`]+/, "").replace(/['"`]+$/, ""));
}

export function stripLsClassifySuffix(raw: string): {
  name: string;
  kindHint: PathLinkKind | null;
} {
  if (raw.length < 2) return { name: raw, kindHint: null };
  const last = raw[raw.length - 1]!;
  if (last === "/" || last === "\\") {
    return { name: raw.slice(0, -1), kindHint: "dir" };
  }
  if (LS_F_FILE_SUFFIX.has(last)) {
    return { name: raw.slice(0, -1), kindHint: "file" };
  }
  return { name: raw, kindHint: null };
}

export function isTypicalDirectoryColor(fgColor: number, isPalette: boolean): boolean {
  if (!isPalette) return false;
  const ansi = fgColor & 0xff;
  return ansi === 4 || ansi === 12;
}

export function isPathLikeToken(text: string): boolean {
  const trimmed = trimTrailingPunctuation(text.trim());
  if (!trimmed) return false;
  FILE_PATH_RE.lastIndex = 0;
  const m = FILE_PATH_RE.exec(trimmed);
  return Boolean(m && m[0] === trimmed);
}

export interface ResolveFilePathInput {
  text: string;
  cwd: string;
  sessionType: TerminalSessionType;
  remoteHome: string | null;
}

export function resolveDetectedFilePath({
  text,
  cwd,
  sessionType,
  remoteHome,
}: ResolveFilePathInput): DetectedFilePath | null {
  const trimmed = unwrapPathToken(text);
  if (!trimmed) return null;
  if (trimmed.length < 1) return null;
  if (trimmed === "." || trimmed === "..") return null;
  if (!/[A-Za-z0-9\u0080-\uFFFF]/.test(trimmed)) return null;

  const stripped = stripLsClassifySuffix(trimmed);
  const core = stripped.name || trimmed;
  const expanded = expandTilde(core, sessionType, remoteHome);
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
    name: basename(absolutePath) || basename(core),
  };
}

function rangesOverlap(
  a: { start: number; end: number },
  b: { start: number; end: number },
): boolean {
  return a.start < b.end && b.start < a.end;
}

/** 在 buffer 行的纯文本中找出所有"文件路径"区间 */
export function detectFilePathRanges(
  line: string,
): Array<{ text: string; start: number; end: number }> {
  const out: Array<{ text: string; start: number; end: number }> = [];
  FILE_PATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FILE_PATH_RE.exec(line)) !== null) {
    const raw = unwrapPathToken(m[0]);
    const start = m.index;
    const end = start + raw.length;
    if (!/[A-Za-z0-9\u0080-\uFFFF]/.test(raw)) continue;
    if (/^[A-Za-z]+:\/\//.test(raw)) continue;
    if (raw.includes("://")) continue;
    out.push({ text: raw, start, end });
  }
  return out;
}

export function detectBareNameRanges(
  line: string,
  occupied: Array<{ start: number; end: number }>,
): Array<{ text: string; start: number; end: number }> {
  const out: Array<{ text: string; start: number; end: number }> = [];
  BARE_NAME_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BARE_NAME_RE.exec(line)) !== null) {
    const raw = trimTrailingPunctuation(m[0]);
    const start = m.index;
    const end = start + raw.length;
    const span = { start, end };
    if (occupied.some((r) => rangesOverlap(span, r))) continue;
    if (raw === "." || raw === "..") continue;
    if (/^--?[A-Za-z0-9]/.test(raw) && !raw.includes("/") && !raw.includes("\\")) continue;
    if (!/[A-Za-z0-9\u0080-\uFFFF]/.test(raw)) continue;
    out.push({ text: raw, start, end });
  }
  return out;
}

function listingHit(
  listing: readonly PathListingHint[] | null,
  name: string,
): PathListingHint | null {
  if (!listing || !name) return null;
  return listing.find((entry) => entry.name === name) ?? null;
}

function isCdArgument(line: string, start: number): boolean {
  return /(?:^|[\s;|&])cd\s+['"`]?$/i.test(line.slice(0, start));
}

function isCwdOrAncestor(absolutePath: string, cwd: string): boolean {
  const abs = absolutePath.replace(/[\\/]+$/, "") || absolutePath;
  const cur = cwd.replace(/[\\/]+$/, "") || cwd;
  if (!abs || !cur) return false;
  if (abs === cur) return true;
  return cur.startsWith(`${abs}/`) || cur.startsWith(`${abs}\\`);
}

function classifyToken(
  token: { text: string; start: number; end: number },
  pathLike: boolean,
  input: ClassifyLinePathLinksInput,
): ClassifiedPathLink | null {
  const stripped = stripLsClassifySuffix(unwrapPathToken(token.text));
  const resolved = resolveDetectedFilePath({
    text: stripped.name,
    cwd: input.cwd,
    sessionType: input.sessionType,
    remoteHome: input.remoteHome,
  });
  if (!resolved) return null;

  const hit =
    listingHit(input.listing, stripped.name) ?? listingHit(input.listing, resolved.name);
  const colorHint = input.isDirectoryColor?.(token.start, token.end) ?? false;

  let kind: PathLinkKind | null = null;
  if (hit) kind = hit.isDir ? "dir" : "file";
  else if (stripped.kindHint) kind = stripped.kindHint;
  else if (colorHint) kind = "dir";
  else if (isCdArgument(input.line, token.start)) kind = "dir";
  else if (isCwdOrAncestor(resolved.absolutePath, input.cwd)) kind = "dir";
  else if (pathLike) kind = "file";
  else return null;

  if (
    resolved.absolutePath.endsWith("/") ||
    resolved.absolutePath.endsWith("\\")
  ) {
    kind = "dir";
  }

  return {
    text: token.text,
    start: token.start,
    end: token.end,
    absolutePath: resolved.absolutePath.replace(/[\\/]+$/, "") || resolved.absolutePath,
    name: resolved.name.replace(/[\\/]+$/, "") || resolved.name,
    kind,
  };
}

function finalizeAbsolutePath(path: string): string {
  if (/^[A-Za-z]:[\\/]?$/.test(path)) return `${path.slice(0, 2)}\\`;
  if (path === "/" || /^[\\/]+$/.test(path)) return "/";
  return path.replace(/[\\/]+$/, "") || path;
}

function inferHomeFromDisplayedCwd(
  displayed: string,
  cwd: string,
  remoteHome: string | null,
): string | null {
  if (remoteHome) return remoteHome;
  const cur = cwd.replace(/[\\/]+$/, "").replace(/\\/g, "/");
  if (!cur) return null;
  if (displayed === "~" || displayed === "~/" || displayed === "~\\") return cur;
  if (displayed.startsWith("~/") || displayed.startsWith("~\\")) {
    const rest = displayed.slice(2).replace(/\\/g, "/").replace(/^\/+/, "");
    const suffix = `/${rest}`;
    if (cur.endsWith(suffix)) return cur.slice(0, -suffix.length) || "/";
  }
  return null;
}

/**
 * 从提示符里取出展示用 cwd（`user@host:~/a/b#` / `PS C:\a>`），不含 user@host。
 */
export function extractPromptCwdDisplay(line: string): { path: string; start: number } | null {
  const prefix = line.slice(0, promptPrefixEndIndex(line));
  if (!prefix) return null;
  const ps = /^(PS\s+)(.+?)(>\s*)$/i.exec(prefix);
  if (ps) {
    return { path: ps[2]!, start: ps[1]!.length };
  }
  const host = /^(.*?:)(.+?)([$#%]\s*)$/.exec(prefix);
  if (host && /^(?:~|\/|\.{1,2}|[A-Za-z]:)/.test(host[2]!)) {
    return { path: host[2]!, start: host[1]!.length };
  }
  return null;
}

function displayedPathSegments(displayed: string): Array<{
  label: string;
  start: number;
  end: number;
  prefix: string;
}> {
  const segs: Array<{ label: string; start: number; end: number; prefix: string }> = [];
  let offset = 0;
  if (displayed.startsWith("~")) {
    segs.push({ label: "~", start: 0, end: 1, prefix: "~" });
    offset = 1;
  } else if (/^[A-Za-z]:/.test(displayed)) {
    segs.push({ label: displayed.slice(0, 2), start: 0, end: 2, prefix: displayed.slice(0, 2) });
    offset = 2;
  } else if (displayed.startsWith("/")) {
    segs.push({ label: "/", start: 0, end: 1, prefix: "/" });
    offset = 1;
  }
  while (offset < displayed.length) {
    const ch = displayed[offset]!;
    if (ch === "/" || ch === "\\") {
      offset += 1;
      continue;
    }
    const slash = displayed.slice(offset).search(/[\\/]/);
    const end = slash < 0 ? displayed.length : offset + slash;
    segs.push({
      label: displayed.slice(offset, end),
      start: offset,
      end,
      prefix: displayed.slice(0, end),
    });
    offset = end;
  }
  return segs;
}

export function detectPromptCwdSegmentLinks(input: ClassifyLinePathLinksInput): ClassifiedPathLink[] {
  const found = extractPromptCwdDisplay(input.line);
  if (!found || !found.path) return [];
  const home = inferHomeFromDisplayedCwd(found.path, input.cwd, input.remoteHome);
  const links: ClassifiedPathLink[] = [];
  for (const seg of displayedPathSegments(found.path)) {
    if (!seg.label) continue;
    const expanded = expandTilde(seg.prefix, input.sessionType, home);
    const absolutePath =
      expanded.startsWith("/") ||
      /^[A-Za-z]:[\\/]?/.test(expanded) ||
      expanded.startsWith("~")
        ? expanded
        : joinPath(input.cwd, expanded);
    links.push({
      text: seg.label,
      start: found.start + seg.start,
      end: found.start + seg.end,
      absolutePath: finalizeAbsolutePath(absolutePath),
      name: seg.label,
      kind: "dir",
    });
  }
  return links;
}

/** 当前行是否为 shell 提示符输入行（含直通模式正在键入的正文） */
export function lineHasShellPromptPrefix(line: string): boolean {
  const trimmed = line.trimEnd();
  if (!trimmed) return false;
  if (/^PS\s+\S+>\s*/u.test(trimmed)) return true;
  return /\S+@\S+.*[$#%]\s*/u.test(trimmed);
}

/** 直通 / 原生输入行上的自然语言正文不应被裸名启发式当成路径 */
export function shouldSkipBodyPathLinksForNaturalLanguage(line: string): boolean {
  if (!lineHasShellPromptPrefix(line)) return false;
  const body = stripShellPromptPrefix(line);
  if (!body) return false;
  return shouldRouteInputToAi(body);
}

export function classifyLinePathLinks(input: ClassifyLinePathLinksInput): ClassifiedPathLink[] {
  const promptEnd = promptPrefixEndIndex(input.line);
  const skipBodyLinks = shouldSkipBodyPathLinksForNaturalLanguage(input.line);
  const pathRanges = detectFilePathRanges(input.line);
  const bareRanges = detectBareNameRanges(input.line, pathRanges);
  const out: ClassifiedPathLink[] = [...detectPromptCwdSegmentLinks(input)];

  const consider = (range: { text: string; start: number; end: number }, pathLike: boolean) => {
    if (range.start < promptEnd) return;
    if (skipBodyLinks) return;
    const link = classifyToken(range, pathLike, input);
    if (link) out.push(link);
  };

  for (const range of pathRanges) consider(range, true);
  for (const range of bareRanges) consider(range, false);

  out.sort((a, b) => a.start - b.start);
  return out;
}

/** xterm ILink 坐标：列 1-based 且 end.x 含尾列；y 必须是 provideLinks 的 buffer 行号。 */
export function buildPathLinkRange(
  start: number,
  end: number,
  bufferLineNumber: number,
): { start: { x: number; y: number }; end: { x: number; y: number } } {
  const startX = start + 1;
  const endX = Math.max(startX, end);
  return {
    start: { x: startX, y: bufferLineNumber },
    end: { x: endX, y: bufferLineNumber },
  };
}
