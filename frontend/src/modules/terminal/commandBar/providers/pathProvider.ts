import { commands } from "../../../../ipc/bindings";
import { listDirectory } from "../../../files/fileApi";
import { LOCAL_CONNECTION_ID } from "../../../files/utils";
import { useConnectionStore } from "../../../../stores/connectionStore";
import type { FileEntry } from "../../../../ipc/bindings";
import { normalizeTerminalCwdForSftp } from "../../../server/ssh/utils/parseCommandPaths";
import { resolveBlockCwd } from "../../lsListing/resolveLsListingDirectory";
import { resolveAbsoluteTerminalCwd } from "../../terminalPathCrumbs";
import type { CompletionCandidate, TerminalCompletionContext } from "../types";
import { fuzzyMatchScore } from "../fuzzyMatch";
import { buildReplacementRange, parseCommandLineForCompletion } from "../parseCommandLine";
import {
  getCachedPathListing,
  pathListingCacheKey,
  setCachedPathListing,
} from "../pathListingCache";

/**
 * 路径补全方法论（命令栏 Tab）：
 *
 * 1. 触发：路径型 token，或已知路径命令的参数位（不含 flag）。
 * 2. 语义过滤：按命令决定只补目录 / 目录+文件。
 * 3. 排序：匹配分（前缀 >> 模糊）→ 语义偏好 → 目录优先默认 → 名字。
 * 4. 点文件：默认隐藏；前缀以 `.` 开头时才露出。
 * 5. 插入：目录带尾 `/` 便于继续下钻；文件不带多余空格污染。
 */

export type PathEntryAccept = "dirs" | "all";
export type PathEntryPrefer = "dirs" | "files" | "none";

export type PathCompletionPolicy = {
  accept: PathEntryAccept;
  /** 同分时的软偏好；accept=dirs 时忽略 */
  prefer: PathEntryPrefer;
};

/** 仅目录：导航 / 删目录 */
const DIRS_ONLY: PathCompletionPolicy = { accept: "dirs", prefer: "dirs" };
/** 目录优先：列举、查找、建目录（便于下钻） */
const DIRS_PREFERRED: PathCompletionPolicy = { accept: "all", prefer: "dirs" };
/** 文件优先：读/编辑（仍保留目录以便进入） */
const FILES_PREFERRED: PathCompletionPolicy = { accept: "all", prefer: "files" };
/** 无偏好：通用文件操作 */
const ANY_PATH: PathCompletionPolicy = { accept: "all", prefer: "none" };

const PATH_COMMAND_POLICIES: Record<string, PathCompletionPolicy> = {
  cd: DIRS_ONLY,
  rmdir: DIRS_ONLY,
  pushd: DIRS_ONLY,
  popd: DIRS_ONLY,

  ls: DIRS_PREFERRED,
  ll: DIRS_PREFERRED,
  find: DIRS_PREFERRED,
  mkdir: DIRS_PREFERRED,
  tree: DIRS_PREFERRED,
  du: DIRS_PREFERRED,

  cat: FILES_PREFERRED,
  vim: FILES_PREFERRED,
  nvim: FILES_PREFERRED,
  nano: FILES_PREFERRED,
  vi: FILES_PREFERRED,
  less: FILES_PREFERRED,
  more: FILES_PREFERRED,
  head: FILES_PREFERRED,
  tail: FILES_PREFERRED,
  source: FILES_PREFERRED,
  open: FILES_PREFERRED,
  code: FILES_PREFERRED,
  bat: FILES_PREFERRED,

  cp: ANY_PATH,
  mv: ANY_PATH,
  rm: ANY_PATH,
  touch: ANY_PATH,
  chmod: ANY_PATH,
  chown: ANY_PATH,
  scp: ANY_PATH,
  tar: ANY_PATH,
  unzip: ANY_PATH,
  zip: ANY_PATH,
  grep: ANY_PATH,
  rg: ANY_PATH,
};

const DEFAULT_PATH_POLICY: PathCompletionPolicy = ANY_PATH;

export type PathListEntry = { name: string; isDir: boolean };

function resolvePathBase(cwd: string, partial: string): { dir: string; prefix: string } {
  if (partial.startsWith("/") || /^[A-Za-z]:[\\/]/.test(partial)) {
    const slash = Math.max(partial.lastIndexOf("/"), partial.lastIndexOf("\\"));
    if (slash === -1) return { dir: partial.endsWith("/") ? partial : "/", prefix: partial };
    return {
      dir: partial.slice(0, slash + 1) || "/",
      prefix: partial.slice(slash + 1),
    };
  }
  const base = cwd.replace(/\\/g, "/").replace(/\/$/, "") || "/";
  const slash = partial.lastIndexOf("/");
  if (slash === -1) {
    return { dir: base, prefix: partial };
  }
  const relDir = partial.slice(0, slash + 1);
  const joined = relDir.startsWith("/") ? relDir : `${base}/${relDir}`.replace(/\/+/g, "/");
  return { dir: joined, prefix: partial.slice(slash + 1) };
}

function commandName(ctx: TerminalCompletionContext): string {
  const parsed = parseCommandLineForCompletion(ctx.input, ctx.cursor);
  return parsed.tokens[0]?.text?.toLowerCase() ?? "";
}

export function resolvePathCompletionPolicy(ctx: TerminalCompletionContext): PathCompletionPolicy {
  const cmd = commandName(ctx);
  if (!cmd) return DEFAULT_PATH_POLICY;
  return PATH_COMMAND_POLICIES[cmd] ?? DEFAULT_PATH_POLICY;
}

function shouldSuggestPath(ctx: TerminalCompletionContext): boolean {
  const parsed = parseCommandLineForCompletion(ctx.input, ctx.cursor);
  const token = parsed.activeToken;
  if (!token) return false;
  if (token.kind === "flag" || token.kind === "resource") return false;
  if (token.kind === "path") return true;
  const cmd = parsed.tokens[0]?.text?.toLowerCase();
  if (!cmd) return false;
  return cmd in PATH_COMMAND_POLICIES;
}

export function isPathCompletionInput(ctx: TerminalCompletionContext): boolean {
  return shouldSuggestPath(ctx);
}

function resolveRemoteSessionUser(resourceId: string | null): string | null {
  if (!resourceId) return "root";
  try {
    const conn = useConnectionStore.getState().connections.find((item) => item.id === resourceId);
    if (!conn?.config) return "root";
    const cfg = JSON.parse(conn.config) as Record<string, unknown>;
    return typeof cfg.user === "string" ? cfg.user : "root";
  } catch {
    return "root";
  }
}

/** 将终端 cwd + 部分路径转为可用于 SFTP / 本地列目录的绝对路径 */
export function resolveCompletionListingDirectory(
  ctx: TerminalCompletionContext,
  partial: string,
): { dir: string; prefix: string } {
  const { dir, prefix } = resolvePathBase(ctx.cwd || "/", partial);
  if (ctx.sessionType === "local") {
    return { dir: (resolveBlockCwd(dir, null) ?? dir) || "/", prefix };
  }

  const sessionUser = resolveRemoteSessionUser(ctx.resourceId);
  const resolved =
    normalizeTerminalCwdForSftp(dir) ??
    (dir.startsWith("~") || dir.startsWith("/")
      ? resolveAbsoluteTerminalCwd(dir, sessionUser)
      : null) ??
    resolveBlockCwd(dir, sessionUser) ??
    resolveBlockCwd(ctx.cwd, sessionUser) ??
    resolveAbsoluteTerminalCwd(dir, sessionUser);
  const trimmed = resolved?.trim();
  if (!trimmed || trimmed === "~") {
    return { dir: resolveAbsoluteTerminalCwd(ctx.cwd, sessionUser), prefix };
  }
  return { dir: trimmed, prefix };
}

/** 解析路径补全的替换区间与前缀；命令名本身不作为路径前缀 */
export function resolvePathCompletionTarget(ctx: TerminalCompletionContext): {
  partial: string;
  replacement: { start: number; end: number };
  leadSpace: boolean;
} | null {
  const parsed = parseCommandLineForCompletion(ctx.input, ctx.cursor);
  const token = parsed.activeToken;
  if (!token) return null;

  const cmd = parsed.tokens[0]?.text?.toLowerCase() ?? "";
  // 光标停在路径命令上时：补全下一参数，而不是用命令名过滤目录
  if (token.kind === "command" && cmd in PATH_COMMAND_POLICIES) {
    return {
      partial: "",
      replacement: { start: token.end, end: Math.max(token.end, ctx.cursor) },
      leadSpace: true,
    };
  }

  return {
    partial: token.text,
    replacement: buildReplacementRange(token, ctx.cursor),
    leadSpace: false,
  };
}

function kindRank(entry: PathListEntry, prefer: PathEntryPrefer): number {
  if (prefer === "dirs") return entry.isDir ? 1 : 0;
  if (prefer === "files") return entry.isDir ? 0 : 1;
  // none：同分时仍目录优先，便于继续下钻
  return entry.isDir ? 1 : 0;
}

/**
 * 过滤 + 排序路径条目（纯函数，供单测）。
 * 返回已截断的候选，最多 `limit` 条。
 */
export function filterAndRankPathEntries(
  entries: PathListEntry[],
  prefix: string,
  policy: PathCompletionPolicy,
  limit = 20,
): PathListEntry[] {
  const showDotfiles = prefix.startsWith(".");
  const scored: Array<{ entry: PathListEntry; score: number; kind: number }> = [];

  for (const entry of entries) {
    if (policy.accept === "dirs" && !entry.isDir) continue;
    if (!showDotfiles && entry.name.startsWith(".")) continue;
    const score = prefix ? fuzzyMatchScore(prefix, entry.name) : 1;
    if (score <= 0) continue;
    scored.push({
      entry,
      score,
      kind: kindRank(entry, policy.prefer),
    });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.kind - a.kind ||
      a.entry.name.localeCompare(b.entry.name),
  );

  return scored.slice(0, limit).map((item) => item.entry);
}

function mapDirEntries(
  names: PathListEntry[],
  partial: string,
  prefix: string,
  dir: string,
  replacement: { start: number; end: number },
  policy: PathCompletionPolicy,
  leadSpace = false,
): CompletionCandidate[] {
  const ranked = filterAndRankPathEntries(names, prefix, policy);
  return ranked.map((entry) => {
    const suffix = entry.isDir ? "/" : "";
    const body =
      partial.includes("/") || partial.includes("\\")
        ? `${partial.slice(0, partial.length - prefix.length)}${entry.name}${suffix}`
        : `${entry.name}${suffix}`;
    const insertText = `${leadSpace ? " " : ""}${body}`;
    return {
      id: `path:${dir}:${entry.name}`,
      label: entry.name + (entry.isDir ? "/" : ""),
      insertText,
      description: dir,
      source: "path" as const,
      priority: "high" as const,
      replacement,
    };
  });
}

async function listRemoteDirectory(
  resourceId: string,
  dir: string,
): Promise<PathListEntry[]> {
  const res = await commands.sftpList(resourceId, dir || "/");
  if (res.status !== "ok") return [];
  return res.data.map((entry) => ({ name: entry.name, isDir: entry.isDir }));
}

async function listLocalDirectory(dir: string): Promise<PathListEntry[]> {
  const result = await listDirectory(LOCAL_CONNECTION_ID, dir || "/", null, null, { quiet: true });
  return result.entries.map((entry: FileEntry) => ({
    name: entry.name,
    isDir: entry.kind === "dir",
  }));
}

function resolvePathSuggestParts(ctx: TerminalCompletionContext): {
  partial: string;
  replacement: { start: number; end: number };
  leadSpace: boolean;
  dir: string;
  prefix: string;
  policy: PathCompletionPolicy;
} | null {
  if (!shouldSuggestPath(ctx)) return null;
  const target = resolvePathCompletionTarget(ctx);
  if (!target) return null;
  const { dir, prefix } = resolveCompletionListingDirectory(ctx, target.partial);
  return {
    ...target,
    dir,
    prefix,
    policy: resolvePathCompletionPolicy(ctx),
  };
}

async function listDirectoryCached(
  ctx: TerminalCompletionContext,
  dir: string,
): Promise<PathListEntry[]> {
  const key = pathListingCacheKey(ctx.sessionType, ctx.resourceId, dir);
  const cached = getCachedPathListing(key);
  if (cached) return cached;

  const entries =
    ctx.sessionType === "local"
      ? await listLocalDirectory(dir)
      : ctx.resourceId
        ? await listRemoteDirectory(ctx.resourceId, dir)
        : [];
  setCachedPathListing(key, entries);
  return entries;
}

/** 目录已缓存时同步出候选（前缀变化无需 IPC） */
export function suggestPathsCached(ctx: TerminalCompletionContext): CompletionCandidate[] | null {
  const parts = resolvePathSuggestParts(ctx);
  if (!parts) return [];
  const key = pathListingCacheKey(ctx.sessionType, ctx.resourceId, parts.dir);
  const cached = getCachedPathListing(key);
  if (!cached) return null;
  return mapDirEntries(
    cached,
    parts.partial,
    parts.prefix,
    parts.dir,
    parts.replacement,
    parts.policy,
    parts.leadSpace,
  );
}

export async function suggestPaths(ctx: TerminalCompletionContext): Promise<CompletionCandidate[]> {
  const parts = resolvePathSuggestParts(ctx);
  if (!parts) return [];

  try {
    const entries = await listDirectoryCached(ctx, parts.dir);
    return mapDirEntries(
      entries,
      parts.partial,
      parts.prefix,
      parts.dir,
      parts.replacement,
      parts.policy,
      parts.leadSpace,
    );
  } catch {
    return [];
  }
}

export function suggestWorkspaceResources(ctx: TerminalCompletionContext): CompletionCandidate[] {
  const parsed = parseCommandLineForCompletion(ctx.input, ctx.cursor);
  const token = parsed.activeToken;
  if (!token || !token.text.startsWith("@")) return [];

  const prefix = token.text.slice(1).toLowerCase();
  const replacement = buildReplacementRange(token, ctx.cursor);
  const connections = useConnectionStore.getState().connections;
  const candidates: CompletionCandidate[] = [];

  for (const conn of connections) {
    const label = `@${conn.name}`;
    if (prefix && !conn.name.toLowerCase().includes(prefix)) continue;
    candidates.push({
      id: `res:${conn.id}`,
      label,
      insertText: label,
      description: conn.kind,
      source: "resource",
      priority: "default",
      replacement,
    });
    if (candidates.length >= 15) break;
  }

  return candidates;
}
