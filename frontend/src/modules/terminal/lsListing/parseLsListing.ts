import { normalizeBlockCommand } from "../terminalOutputText";
import { looksLikeShellCommandEcho } from "../terminalCommandEcho";
import { extractListCommandFromCompound } from "../terminalAutoLsShell";
export type LsEntryKind =
  | "directory"
  | "symlink"
  | "executable"
  | "archive"
  | "image"
  | "media"
  | "code"
  | "config"
  | "file";

export type LsEntry = {
  name: string;
  kind: LsEntryKind;
  /** 是否可点击执行 cd（目录、目录型符号链接等） */
  navigable?: boolean;
  /** 长格式前缀（权限/模式、属主等，不含 size 与文件名） */
  longDetail?: string;
  /** 长格式 size 列（目录为空字符串；CMD 目录为 <DIR>） */
  longSize?: string;
  /** 长格式 size 之后、文件名之前（如 ls -l 的月日时分） */
  longTrailing?: string;
  /** 长格式逐列元数据（不含文件名），用于分栏对齐 */
  longFields?: string[];
};

export type LsListing = {
  entries: LsEntry[];
  layout: "grid" | "long";
};

const EXTENSIONLESS_FILES = new Set(
  [
    "Makefile",
    "makefile",
    "GNUmakefile",
    "README",
    "LICENSE",
    "LICENCE",
    "COPYING",
    "Dockerfile",
    "Containerfile",
    "Jenkinsfile",
    "Gemfile",
    "Rakefile",
    "Vagrantfile",
    "Procfile",
    "BUILD",
    "WORKSPACE",
    "CMakeLists.txt",
  ].map((s) => s.toLowerCase()),
);

const ARCHIVE_EXT = new Set([
  "zip",
  "tar",
  "gz",
  "tgz",
  "bz2",
  "xz",
  "7z",
  "rar",
  "deb",
  "rpm",
  "dmg",
  "iso",
  "apk",
  "whl",
]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "tiff", "psd"]);
const MEDIA_EXT = new Set(["mp4", "mkv", "avi", "mov", "mp3", "wav", "flv", "m4v", "aac", "ogg"]);
const CODE_EXT = new Set([
  "py",
  "js",
  "ts",
  "tsx",
  "jsx",
  "rs",
  "go",
  "java",
  "c",
  "cpp",
  "h",
  "sh",
  "bash",
  "zsh",
  "php",
  "rb",
  "sql",
  "html",
  "css",
  "vue",
  "ipynb",
]);
const CONFIG_EXT = new Set(["json", "yaml", "yml", "toml", "xml", "ini", "cfg", "conf", "env"]);

function unquoteName(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** 剥除 ls -F / --indicator-style 追加的 / * @ = 后缀 */
export function normalizeLsEntryName(name: string): string {
  let base = name;
  if (base.endsWith("/")) {
    return base.replace(/\/+$/, "");
  }
  if (base.endsWith("*") || base.endsWith("@") || base.endsWith("=")) {
    return base.slice(0, -1);
  }
  return base;
}

/** 目录展示名：保证至多一个尾部 / */
export function lsEntryDisplayName(entry: { name: string; kind: LsEntryKind }): string {
  const base = normalizeLsEntryName(entry.name);
  return entry.kind === "directory" ? `${base}/` : base;
}

function extractExtension(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".tar.gz")) return "tgz";
  if (lower.endsWith(".tar.bz2")) return "bz2";
  if (lower.endsWith(".tar.xz")) return "xz";
  const dot = lower.lastIndexOf(".");
  if (dot <= 0 || dot === lower.length - 1) return "";
  return lower.slice(dot + 1);
}

function isExtensionlessFile(name: string): boolean {
  return EXTENSIONLESS_FILES.has(name.toLowerCase());
}

function hasFileExtension(name: string): boolean {
  if (name.startsWith(".")) return name.length > 1 && name.includes(".", 1);
  return extractExtension(name).length > 0;
}

function classifyByExtension(name: string): LsEntryKind {
  const ext = extractExtension(name);
  if (!ext) return "file";
  if (ext === "sh" || ext === "bash" || ext === "exe" || ext === "bat" || ext === "cmd" || ext === "dll") {
    return "executable";
  }
  if (ARCHIVE_EXT.has(ext)) return "archive";
  if (IMAGE_EXT.has(ext)) return "image";
  if (MEDIA_EXT.has(ext)) return "media";
  if (CODE_EXT.has(ext)) return "code";
  if (CONFIG_EXT.has(ext)) return "config";
  return "file";
}

/** 按文件名扩展名推断类型（供 SFTP 元数据修正后回退使用）。 */
export function classifyLsEntryKindFromName(name: string): LsEntryKind {
  if (isExtensionlessFile(name)) return "file";
  if (!hasFileExtension(name)) return "file";
  return classifyByExtension(name);
}

export function isLsExtensionlessFileName(name: string): boolean {
  const base = name.split("/").pop() ?? name;
  return isExtensionlessFile(base);
}

/** PowerShell Mode：d/- 开头 + 4–6 位属性（a r h s l 或 -）；`-` 必须放在字符类末尾 */
const WINDOWS_LINE_MODE = /^([d-][arhslARHSL-]{4,6})\s+/i;

function isWindowsModeToken(value: string): boolean {
  return /^[d-][arhslARHSL-]{4,6}$/i.test(value);
}

function isPowerShellDirOutput(lines: string[]): boolean {
  if (lines.some((line) => /^Directory:/i.test(line.trim()))) return true;
  if (lines.some((line) => /^Mode\s+LastWriteTime/i.test(line))) return true;
  const modeLines = lines.filter((line) => WINDOWS_LINE_MODE.test(line));
  return modeLines.length >= 1;
}

function isCmdDirOutput(lines: string[]): boolean {
  if (lines.some((line) => /^Directory of /i.test(line.trim()))) return true;
  return lines.some((line) => /^\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}/.test(line) && /<DIR>|\d/.test(line));
}

function parsePowerShellDirLine(line: string): LsEntry | null {
  const modeMatch = line.match(WINDOWS_LINE_MODE);
  if (!modeMatch) return null;

  const mode = modeMatch[1]!;
  const rest = line.slice(modeMatch[0].length).trim();
  // Format-Table 用 2+ 空格/制表符分列；Name 为最后一列
  const columns = rest.split(/\s{2,}|\t+/).filter(Boolean);
  if (columns.length < 2) return null;

  let tail = columns[columns.length - 1]!;
  let size = "";
  const sizeName = tail.match(/^(\d[\d,]*)\s+(.+)$/);
  if (sizeName) {
    size = sizeName[1]!.replace(/,/g, "");
    tail = sizeName[2]!;
  }

  const name = unquoteName(tail);
  if (!name || isWindowsModeToken(name)) return null;

  const beforeName = columns.slice(0, -1).join("  ");
  const isDir = mode.toLowerCase().startsWith("d");
  const kind: LsEntryKind = isDir ? "directory" : classifyByExtension(name);

  return {
    name,
    kind,
    navigable: isDir,
    longDetail: [mode, beforeName].join("  "),
    longSize: size,
    longFields: [mode, beforeName, size],
  };
}

function parseCmdDirLine(line: string): LsEntry | null {
  const match = line.match(
    /^(\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}(?:\s+[AP]M)?)\s+(<DIR>|\d[\d,]*)\s+(.+)$/i,
  );
  if (!match) return null;

  const [, dateTime, marker, rawName] = match;
  const name = unquoteName(rawName.trim());
  if (!name) return null;

  const isDir = marker.toUpperCase() === "<DIR>";
  const size = isDir ? "" : marker.replace(/,/g, "");
  const kind: LsEntryKind = isDir ? "directory" : classifyByExtension(name);

  return {
    name,
    kind,
    navigable: isDir,
    longDetail: dateTime,
    longSize: isDir ? "<DIR>" : size,
    longFields: [dateTime, isDir ? "<DIR>" : size],
  };
}

function tryParseWindowsDirListing(lines: string[]): LsListing | null {
  const entries: LsEntry[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^Directory:/i.test(trimmed) || /^Directory of /i.test(trimmed)) continue;
    if (/^Mode\s+LastWriteTime/i.test(trimmed)) continue;
    if (/^----+\s+----+/i.test(trimmed)) continue;
    if (/^(Mode|LastWriteTime|Length|Name)$/i.test(trimmed)) continue;

    const entry = parsePowerShellDirLine(line) ?? parseCmdDirLine(line);
    if (entry) entries.push(entry);
  }

  if (entries.length === 0) return null;
  return { entries, layout: "long" };
}

function isGridNoiseToken(token: string): boolean {
  if (isWindowsModeToken(token)) return true;
  if (/^-{3,}$/.test(token)) return true;
  if (/^(Mode|LastWriteTime|Length|Name|Directory:|Directory)$/i.test(token)) return true;
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(token)) return true;
  return false;
}

function classifyPlainName(raw: string): LsEntry {
  let name = unquoteName(raw);
  if (isWindowsModeToken(name) || isGridNoiseToken(name)) {
    return { name, kind: "file" };
  }
  let kind: LsEntryKind = "file";

  if (name.endsWith("/")) {
    kind = "directory";
    name = name.slice(0, -1);
  } else if (name.endsWith("*")) {
    kind = "executable";
    name = name.slice(0, -1);
  } else if (name.endsWith("@")) {
    kind = "symlink";
    name = name.slice(0, -1);
  } else if (name.endsWith("=")) {
    kind = "file";
    name = name.slice(0, -1);
  } else if (!hasFileExtension(name) && !isExtensionlessFile(name)) {
    kind = "directory";
  } else {
    kind = classifyByExtension(name);
  }

  const entry: LsEntry = { name: unquoteName(name), kind };
  if (kind === "directory" || kind === "symlink") {
    return { ...entry, navigable: true };
  }
  return entry;
}

function modeToKind(modeChar: string, mode: string): LsEntryKind {
  if (modeChar === "d") return "directory";
  if (modeChar === "l") return "symlink";
  if (modeChar === "b" || modeChar === "c" || modeChar === "p" || modeChar === "s") return "file";
  if (mode.includes("x")) return "executable";
  return "file";
}

function parseLongLine(line: string): LsEntry | null {
  const match = line.match(/^([-dlbcps])([rwx-]{9})\s+/);
  if (!match) return null;

  const parts = line.trim().split(/\s+/);
  if (parts.length < 8) return null;

  let nameStart = 8;
  if (/^\d{4}-\d{2}-\d{2}$/.test(parts[5] ?? "")) {
    nameStart = 7;
  }

  let rawName = parts.slice(nameStart).join(" ");
  if (rawName.includes(" -> ")) {
    rawName = rawName.split(" -> ")[0]!.trim();
  }

  const name = normalizeLsEntryName(unquoteName(rawName));
  if (!name) return null;

  const modeChar = match[1]!;
  const kind = modeToKind(modeChar, match[2]!);

  const metaParts = parts.slice(0, nameStart);

  return {
    name,
    kind,
    navigable: modeChar === "d" || modeChar === "l",
    longDetail: parts.slice(0, 4).join(" "),
    longSize: parts[4] ?? "",
    longTrailing: parts.slice(5, nameStart).join(" "),
    longFields: metaParts,
  };
}

function tokenizePlainLsOutput(output: string): string[] {
  const entries: string[] = [];
  const pattern = /'([^']*)'|"([^"]*)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(output)) !== null) {
    const token = match[1] ?? match[2] ?? match[3];
    if (token) entries.push(token);
  }
  return entries;
}

const LS_COMMAND_BASES = new Set(["ls", "dir", "ll", "la", "l", "get-childitem", "gci"]);

/** 从 block 命令中解析用于列表渲染的 ls 子命令 */
export function resolveListingCommandForBlock(command: string): string | null {
  const cmd = normalizeBlockCommand(command).trim();
  if (isDirectLsListingCommand(cmd)) return cmd;
  const tail = extractListCommandFromCompound(cmd);
  if (tail && isDirectLsListingCommand(tail)) return tail;
  return null;
}

function isDirectLsListingCommand(command: string): boolean {
  const base = lsListingCommandBase(command).toLowerCase();
  if (!base) return false;
  if (LS_COMMAND_BASES.has(base)) return true;
  return base.endsWith("/ls") || base.endsWith("\\ls");
}

/** 取归一化后的列表命令主命令名（ls / ll / dir …） */
export function lsListingCommandBase(command: string): string {
  return normalizeBlockCommand(command).trim().split(/\s+/)[0] ?? "";
}

export function isLsListingCommand(command: string): boolean {
  return resolveListingCommandForBlock(command) != null;
}

function isLongListing(command: string): boolean {
  const listingCommand = resolveListingCommandForBlock(command) ?? command;
  const cmd = normalizeBlockCommand(listingCommand);
  const base = lsListingCommandBase(listingCommand);
  if (base === "ll" || base === "l") return true;
  return /(^|\s)-[a-zA-Z]*l[a-zA-Z]*(\s|$)/.test(cmd);
}

function shouldParseAsLongListing(command: string, lines: string[]): boolean {
  if (isLongListing(command)) return true;
  const longLines = lines.filter((line) => /^[-dlbcps][rwx-]{9}\s/.test(line));
  if (longLines.length === 0) return false;
  // 避免 plain ls 输出里夹杂一行权限串时整段解析失败
  return longLines.length >= Math.max(2, Math.ceil(lines.length * 0.6));
}

/** 解析 ls / dir 输出为结构化列表；无法识别时返回 null */
export function tryParseLsListing(command: string, output: string): LsListing | null {
  const listingCommand = resolveListingCommandForBlock(command);
  if (!listingCommand) return null;

  const text = output.trim().replace(/\r/g, "\n");
  if (!text) return null;

  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return null;

  if (isPowerShellDirOutput(lines) || isCmdDirOutput(lines)) {
    return tryParseWindowsDirListing(lines);
  }

  if (shouldParseAsLongListing(listingCommand, lines)) {
    const entries: LsEntry[] = [];
    for (const line of lines) {
      if (line.startsWith("total ")) continue;
      const entry = parseLongLine(line);
      if (!entry) {
        if (entries.length > 0) return null;
        continue;
      }
      entries.push(entry);
    }
    if (entries.length > 0) return { entries, layout: "long" };
  }

  const gridSource = lines
    .filter((line) => !/^[-dlbcps][rwx-]{9}\s/.test(line))
    .join(" ")
    .trim();
  if (looksLikeShellCommandEcho(gridSource || text)) return null;

  const tokens = tokenizePlainLsOutput(gridSource || text).filter((token) => !isGridNoiseToken(token));
  if (tokens.length < 1) return null;

  const invalid = tokens.some(
    (token) => token.length > 260 || token.includes("=") && token.includes("error"),
  );
  if (invalid) return null;

  return {
    entries: tokens.map(classifyPlainName),
    layout: "grid",
  };
}

export function shellQuotePath(name: string): string {
  if (/^[a-zA-Z0-9._@+-]+$/.test(name)) return name;
  return `'${name.replace(/'/g, `'\\''`)}'`;
}
