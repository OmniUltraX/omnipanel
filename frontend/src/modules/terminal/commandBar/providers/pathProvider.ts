import { commands } from "../../../../ipc/bindings";
import { listDirectory } from "../../../files/fileApi";
import { LOCAL_CONNECTION_ID } from "../../../files/utils";
import { useConnectionStore } from "../../../../stores/connectionStore";
import type { FileEntry } from "../../../../ipc/bindings";
import { normalizeTerminalCwdForSftp } from "../../../server/ssh/utils/parseCommandPaths";
import { resolveBlockCwd } from "../../lsListing/resolveLsListingDirectory";
import { resolveAbsoluteTerminalCwd } from "../../terminalPathCrumbs";
import type { CompletionCandidate, TerminalCompletionContext } from "../types";
import { fuzzyMatches } from "../fuzzyMatch";
import { buildReplacementRange, parseCommandLineForCompletion } from "../parseCommandLine";

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

function shouldSuggestPath(ctx: TerminalCompletionContext): boolean {
  const parsed = parseCommandLineForCompletion(ctx.input, ctx.cursor);
  const token = parsed.activeToken;
  if (!token) return false;
  if (token.kind === "path") return true;
  const cmd = parsed.tokens[0]?.text?.toLowerCase();
  if (!cmd) return false;
  return PATH_COMMANDS.has(cmd);
}

const PATH_COMMANDS = new Set([
  "cd",
  "ls",
  "cat",
  "vim",
  "nano",
  "vi",
  "cp",
  "mv",
  "rm",
  "touch",
  "head",
  "tail",
  "less",
  "more",
  "grep",
  "find",
  "chmod",
  "chown",
  "mkdir",
  "rmdir",
  "scp",
  "source",
  "tar",
  "unzip",
  "zip",
]);

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
  let resolved =
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

function mapDirEntries(
  names: Array<{ name: string; isDir: boolean }>,
  partial: string,
  prefix: string,
  dir: string,
  replacement: { start: number; end: number },
): CompletionCandidate[] {
  return names
    .filter((entry) => !prefix || fuzzyMatches(prefix, entry.name))
    .slice(0, 20)
    .map((entry) => {
      const suffix = entry.isDir ? "/" : " ";
      const insertText =
        partial.includes("/") || partial.includes("\\")
          ? `${partial.slice(0, partial.length - prefix.length)}${entry.name}${suffix}`.trimEnd()
          : `${entry.name}${suffix}`.trimEnd();
      return {
        id: `path:${dir}:${entry.name}`,
        label: entry.name + (suffix === "/" ? "/" : ""),
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
): Promise<Array<{ name: string; isDir: boolean }>> {
  const res = await commands.sftpList(resourceId, dir || "/");
  if (res.status !== "ok") return [];
  return res.data.map((entry) => ({ name: entry.name, isDir: entry.isDir }));
}

async function listLocalDirectory(dir: string): Promise<Array<{ name: string; isDir: boolean }>> {
  const result = await listDirectory(LOCAL_CONNECTION_ID, dir || "/", null, null, { quiet: true });
  return result.entries.map((entry: FileEntry) => ({
    name: entry.name,
    isDir: entry.kind === "dir",
  }));
}

export async function suggestPaths(ctx: TerminalCompletionContext): Promise<CompletionCandidate[]> {
  if (!shouldSuggestPath(ctx)) return [];

  const parsed = parseCommandLineForCompletion(ctx.input, ctx.cursor);
  const token = parsed.activeToken;
  if (!token) return [];

  const partial = token.text;
  const { dir, prefix } = resolveCompletionListingDirectory(ctx, partial);
  const replacement = buildReplacementRange(token, ctx.cursor);

  try {
    const entries =
      ctx.sessionType === "local"
        ? await listLocalDirectory(dir)
        : ctx.resourceId
          ? await listRemoteDirectory(ctx.resourceId, dir)
          : [];
    return mapDirEntries(entries, partial, prefix, dir, replacement);
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
