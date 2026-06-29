import { normalizeTerminalCwdForSftp } from "@/modules/server/ssh/utils/parseCommandPaths";
import { expandTildePath, resolveAbsoluteTerminalCwd } from "../terminalPathCrumbs";

import { isLsExtensionlessFileName, isLsListingCommand, lsListingCommandBase, resolveListingCommandForBlock } from "./parseLsListing";
import { normalizeBlockCommand, stripTerminalControlSequences } from "../terminalOutputText";
import { isCdOnlyCommand, stripAutoLsSuffix } from "../terminalAutoLsPolicy";

function normalizeRemotePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join("/")}` || "/";
}

function remoteDirname(path: string): string {
  const trimmed = path.replace(/\/+$/, "") || "/";
  if (trimmed === "/") return "/";
  const idx = trimmed.lastIndexOf("/");
  return idx <= 0 ? "/" : trimmed.slice(0, idx);
}

function unquoteArg(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** 将终端 cwd 转为可用于 SFTP / 文件 API 列目录的绝对路径 */
export function resolveBlockCwd(
  cwd: string,
  sessionUser?: string | null,
  ...hints: Array<string | null | undefined>
): string | null {
  const trimmed = cwd.trim();
  if (/^[A-Za-z]:$/.test(trimmed)) {
    return `${trimmed}\\`;
  }
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) {
    return trimmed.replace(/\//g, "\\");
  }
  if (trimmed.startsWith("~")) {
    const expanded = expandTildePath(trimmed, sessionUser, ...hints);
    if (expanded !== trimmed && /^[A-Za-z]:/i.test(expanded.replace(/\//g, "\\"))) {
      return expanded.replace(/\//g, "\\");
    }
  }
  return normalizeTerminalCwdForSftp(cwd) ?? resolveAbsoluteTerminalCwd(cwd, sessionUser);
}

function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path);
}

function joinWindowsListingPath(base: string, segment: string): string {
  const root = base.replace(/[\\/]+$/, "") || base;
  const name = segment.replace(/^[\\/]+/, "");
  return `${root}\\${name}`;
}

function looksLikeExplicitFile(name: string): boolean {
  if (name.endsWith("/")) return false;
  const base = name.split("/").pop() ?? name;
  if (!base || base === "." || base === "..") return false;
  if (isLsExtensionlessFileName(base)) return true;
  if (base.includes(".")) return true;
  return /\.(?:sh|bash|zsh|py|js|mjs|cjs|ts|tsx|jsx|json|ya?ml|toml|ini|conf|cfg|xml|properties|env|log|pid|sock|jar|war|go|rs|java|php|rb|pl|sql|db|sqlite|pem|key|crt|cer|zip|tar|gz|tgz|bz2|xz|7z|rar|deb|rpm)$/i.test(
    base,
  );
}

/** 从 ls 命令与 block cwd 推断 SFTP 应列出的目录（绝对路径）。 */
export function resolveLsListingDirectory(
  command: string,
  cwd: string,
  sessionUser?: string | null,
  cwdHints: string[] = [],
): string | null {
  const listingCommand = resolveListingCommandForBlock(command) ?? command;
  if (!isLsListingCommand(command) && !isLsListingCommand(listingCommand)) return null;

  const trimmed = normalizeBlockCommand(listingCommand).trim();
  const parts = trimmed.split(/\s+/);
  const base = lsListingCommandBase(listingCommand).toLowerCase();

  const blockCwd = resolveBlockCwd(cwd, sessionUser, ...cwdHints);
  if (!blockCwd) return null;

  let index = 1;
  if (base === "ls" || base === "dir" || base === "get-childitem" || base === "gci") {
    while (index < parts.length && /^-/.test(parts[index]!)) {
      index += 1;
    }
  }

  const rawTarget = parts[index];
  if (!rawTarget) return blockCwd;

  const target = unquoteArg(rawTarget);
  if (isWindowsPath(blockCwd)) {
    if (target.endsWith("\\") || target.endsWith("/")) {
      return target.replace(/\//g, "\\");
    }
    if (/^[A-Za-z]:[\\/]/.test(target)) {
      return target.replace(/\//g, "\\");
    }
    return joinWindowsListingPath(blockCwd, target);
  }

  if (target.endsWith("/")) {
    return target.startsWith("/")
      ? normalizeRemotePath(target)
      : normalizeRemotePath(`${blockCwd}/${target}`);
  }

  const absolute = target.startsWith("/")
    ? normalizeRemotePath(target)
    : normalizeRemotePath(`${blockCwd}/${target}`);

  if (looksLikeExplicitFile(target)) {
    return remoteDirname(absolute);
  }

  return absolute;
}

function listingCommandHasExplicitPath(listingCommand: string): boolean {
  const trimmed = normalizeBlockCommand(listingCommand).trim();
  const parts = trimmed.split(/\s+/);
  const base = lsListingCommandBase(listingCommand).toLowerCase();
  let index = 1;
  if (base === "ls" || base === "dir" || base === "get-childitem" || base === "gci") {
    while (index < parts.length && /^-/.test(parts[index]!)) {
      index += 1;
    }
  }
  return Boolean(parts[index]);
}

function extractCdTarget(cdCommand: string): string | null {
  if (!isCdOnlyCommand(cdCommand)) return null;
  const trimmed = normalizeBlockCommand(cdCommand).trim();
  const rawTarget = trimmed.split(/\s+/).slice(1).join(" ").trim();
  if (!rawTarget) return null;
  return unquoteArg(rawTarget);
}

function isAbsoluteCdTarget(target: string): boolean {
  if (target === "~" || target.startsWith("~/")) return true;
  if (target.startsWith("/")) return true;
  return /^[A-Za-z]:/.test(target);
}

function normalizeWindowsCdTarget(target: string, blockCwd: string): string {
  const trimmed = target.replace(/\//g, "\\").trim();
  if (/^[A-Za-z]:$/.test(trimmed)) {
    return `${trimmed}\\`;
  }
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) {
    return trimmed;
  }
  if (trimmed === "\\" || target === "/" || target === "\\") {
    const drive = blockCwd.match(/^([A-Za-z]:)/);
    if (drive) return `${drive[1]}\\`;
  }
  return trimmed;
}

/** 将 ls 列表所在目录与条目名拼接为绝对路径。 */
export function joinListingEntryPath(listingDir: string, entryName: string): string {
  const name = entryName.replace(/[/\\]+$/, "");
  if (/^[A-Za-z]:[\\/]/.test(name)) {
    return name.replace(/\//g, "\\");
  }
  const driveRoot = listingDir.match(/^([A-Za-z]:)[\\/]?$/);
  if (driveRoot) {
    return `${driveRoot[1]}\\${name}`;
  }
  if (/^[A-Za-z]:[\\/]/.test(listingDir) || listingDir.includes("\\")) {
    const base = listingDir.replace(/[\\/]+$/, "") || listingDir;
    return `${base}\\${name}`;
  }
  if (listingDir === "/") return `/${name}`;
  const base = listingDir.replace(/\/+$/, "") || "/";
  return `${base}/${name}`;
}

/** 剥离 PowerShell 列表表头粘连（裸 \\r 被去掉后路径会与 Mode LastWriteTime 拼在一起） */
function sanitizeWindowsShellPath(path: string): string | null {
  let normalized = path.trim().replace(/\//g, "\\");
  if (!/^[A-Za-z]:/.test(normalized)) return null;

  const contaminated = /^(.+?)(?:Mode\s+LastWriteTime|LastWriteTime\s+Length|Length\s+Name)\b/i.exec(
    normalized,
  );
  if (contaminated?.[1]) {
    normalized = contaminated[1].replace(/[\\/]+$/, "");
  }

  const strict = /^([A-Za-z]:(?:\\[^\\]+)*)/.exec(normalized);
  if (strict?.[1]) {
    normalized = strict[1];
  } else if (/^[A-Za-z]:$/.test(normalized)) {
    normalized = `${normalized}\\`;
  }

  if (/\b(LastWriteTime|Length\s+Name)\b/i.test(normalized)) return null;
  const lastSegment = normalized.split("\\").pop() ?? "";
  if (/\bMode\b/i.test(lastSegment)) {
    const fixed = lastSegment.replace(/Mode.*$/i, "");
    if (!fixed) return null;
    const parts = normalized.split("\\");
    parts[parts.length - 1] = fixed;
    normalized = parts.join("\\");
  }

  return normalized || null;
}

function isTrustworthyShellCwd(path: string): boolean {
  const trimmed = path.trim();
  if (!trimmed) return false;
  if (/\bLastWriteTime\b/i.test(trimmed)) return false;
  if (/\bLength\s+Name\b/i.test(trimmed)) return false;
  if (/Mode\s+LastWriteTime/i.test(trimmed)) return false;
  if (/^[A-Za-z]:/i.test(trimmed)) {
    return sanitizeWindowsShellPath(trimmed) !== null;
  }
  return true;
}

function prepareShellOutputForPathParse(output: string): string {
  return output
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

/** 从 block 原始输出末尾的 shell 提示符解析 cd 完成后的 cwd。 */
export function extractTrailingShellPromptCwd(output: string | null | undefined): string | null {
  if (!output?.trim()) return null;
  const lines = prepareShellOutputForPathParse(output)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    const ps = /^PS\s+(.+?)>\s*$/i.exec(line);
    if (ps?.[1] && /^[A-Za-z]:/i.test(ps[1])) {
      return sanitizeWindowsShellPath(ps[1].replace(/\//g, "\\"));
    }
    const unix = /^[^\s]+@[^\s]+:([^\s#$]+)[$#]\s*$/.exec(line);
    if (unix?.[1]) {
      return unix[1]!.replace(/\//g, "/");
    }
  }
  return null;
}

/** 从 PowerShell 列表头（目录:/Directory:）解析 cwd */
export function extractPsListingHeaderCwd(output: string | null | undefined): string | null {
  if (!output?.trim()) return null;
  for (const line of prepareShellOutputForPathParse(output).split("\n")) {
    const match = /(?:目录|Directory):\s*(.+)/i.exec(line.trim());
    if (!match?.[1]) continue;
    const path = sanitizeWindowsShellPath(match[1]);
    if (path) return path;
  }
  return null;
}

/** 综合提示符与列表头，解析命令输出反映的实际 cwd */
export function resolveShellOutputCwd(output: string | null | undefined): string | null {
  for (const resolver of [extractTrailingShellPromptCwd, extractPsListingHeaderCwd] as const) {
    const path = resolver(output);
    if (path && isTrustworthyShellCwd(path)) return path;
  }
  return null;
}

function resolveWindowsUserHome(blockCwd: string): string | null {
  const match = blockCwd.match(/^([A-Za-z]:\\Users\\[^\\]+)/i);
  return match?.[1] ?? null;
}

function isConcreteListingDirectory(path: string): boolean {
  return path !== "~" && !path.startsWith("~/") && Boolean(path.trim());
}

export function resolveListingDirectoryForBlock(
  command: string,
  cwd: string,
  sessionUser?: string | null,
  rawOutput?: string | null,
): string {
  const normalized = normalizeBlockCommand(command).trim();
  const listingCommand = resolveListingCommandForBlock(command) ?? command;
  const cdPart = stripAutoLsSuffix(normalized);
  const isCompoundCdList =
    cdPart !== normalized && isCdOnlyCommand(cdPart) && resolveListingCommandForBlock(command);

  const outputCwd = resolveShellOutputCwd(rawOutput);
  const cwdHints = outputCwd ? [outputCwd] : [];
  const fromCommand = resolveLsListingDirectory(listingCommand, cwd, sessionUser, cwdHints);
  const blockCwd = resolveBlockCwd(cwd, sessionUser, ...cwdHints);
  const promptCwd = outputCwd;

  if (isCompoundCdList && !listingCommandHasExplicitPath(listingCommand)) {
    if (promptCwd) {
      return promptCwd;
    }

    const cdDest = resolveCdDestination(cdPart, cwd, sessionUser);
    const cdTarget = extractCdTarget(cdPart);
    if (cdDest && isConcreteListingDirectory(cdDest)) {
      if (cdTarget && isAbsoluteCdTarget(cdTarget)) {
        return cdDest;
      }
      if (fromCommand && blockCwd && fromCommand === blockCwd && cdDest !== blockCwd) {
        return cdDest;
      }
    }

    if (cdTarget === "~" || cdTarget?.startsWith("~/")) {
      const home = resolveWindowsUserHome(promptCwd ?? blockCwd ?? "");
      if (home) {
        if (cdTarget === "~") return home;
        const sub = cdTarget.slice(2).replace(/\//g, "\\");
        return joinWindowsListingPath(home, sub);
      }
    }
  }

  if (outputCwd && !listingCommandHasExplicitPath(listingCommand)) {
    return outputCwd;
  }

  if (fromCommand) return fromCommand;
  if (blockCwd) return blockCwd;
  return resolveAbsoluteTerminalCwd(cwd, sessionUser);
}

/** 解析 cd 命令的目标目录（用于自动目录预览） */
export function resolveCdDestination(
  command: string,
  cwd: string,
  sessionUser?: string | null,
): string | null {
  if (!isCdOnlyCommand(command)) return null;

  const trimmed = normalizeBlockCommand(command).trim();
  const parts = trimmed.split(/\s+/);
  const rawTarget = parts.slice(1).join(" ").trim();
  const blockCwd = resolveBlockCwd(cwd, sessionUser);
  if (!blockCwd) return null;

  if (!rawTarget) {
    return resolveAbsoluteTerminalCwd("~", sessionUser);
  }

  const target = unquoteArg(rawTarget);
  if (target === "~" || target.startsWith("~/")) {
    const windowsHome = isWindowsPath(blockCwd) ? resolveWindowsUserHome(blockCwd) : null;
    if (windowsHome) {
      if (target === "~") return windowsHome;
      return joinWindowsListingPath(windowsHome, target.slice(2).replace(/\//g, "\\"));
    }
    return resolveAbsoluteTerminalCwd(target, sessionUser);
  }
  if (isWindowsPath(blockCwd) || /^[A-Za-z]:/.test(target)) {
    const normalized = normalizeWindowsCdTarget(target, blockCwd);
    if (/^[A-Za-z]:[\\/]/.test(normalized)) {
      return normalized;
    }
    return joinWindowsListingPath(blockCwd, target);
  }

  if (target.startsWith("/")) {
    return normalizeRemotePath(target);
  }
  return normalizeRemotePath(`${blockCwd}/${target}`);
}
