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

function dirname(path: string): string {
  const trimmed = path.replace(/\/+$/, "") || "/";
  if (trimmed === "/") return "/";
  const idx = trimmed.lastIndexOf("/");
  return idx <= 0 ? "/" : trimmed.slice(0, idx);
}

function looksLikeFilePath(path: string, rawPath?: string): boolean {
  if (rawPath?.endsWith("/")) return false;
  const base = path.split("/").pop() ?? "";
  if (!base || base === "." || base === "..") return false;
  if (base.includes(".")) return true;
  if (/\/(?:s?bin|libexec)\//.test(path) && !["bin", "sbin", "libexec"].includes(base)) {
    return true;
  }
  return /\.(?:sh|bash|zsh|py|js|mjs|cjs|ts|tsx|jsx|json|ya?ml|toml|ini|conf|cfg|xml|properties|env|log|pid|sock|jar|war|go|rs|java|php|rb|pl|sql|db|sqlite|pem|key|crt|cer)$/i.test(base);
}

function toDirectoryPath(rawPath: string, cwd?: string | null, forceFile = false): string | null {
  let cleaned = rawPath.trim().replace(/^[`'"]+|[`'",;:]+$/g, "");
  if (!cleaned || cleaned === "/" || cleaned.startsWith("-")) return null;
  cleaned = cleaned.replace(/^file:\/\//, "");

  let absolute: string | null = null;
  if (cleaned.startsWith("/")) {
    absolute = normalizeRemotePath(cleaned);
  } else if (cleaned.startsWith("./") || cleaned.startsWith("../")) {
    const base = cwd?.trim();
    if (!base?.startsWith("/")) return null;
    absolute = normalizeRemotePath(`${base}/${cleaned}`);
  }

  if (!absolute || absolute === "/") return absolute;
  return forceFile || looksLikeFilePath(absolute, cleaned) ? dirname(absolute) : absolute;
}

/** 从进程命令行中提取可跳转目录（相对路径会基于 cwd 解析，文件名会剥离）。 */
export function parsePathsFromCommand(command: string, cwd?: string | null): string[] {
  const found = new Set<string>();
  const re = /(?:^|[\s"'=,])((?:\/|\.\.?\/)(?:[\w.\-+~@]+(?:\/[\w.\-+~@]+)*\/?))/g;
  for (const match of command.matchAll(re)) {
    const beforePath = match[0].slice(0, match[0].length - match[1].length);
    const prefix = command.slice(0, match.index) + beforePath;
    const isCommandExecutable = prefix.trim().length === 0;
    const dir = toDirectoryPath(match[1], cwd, isCommandExecutable);
    if (dir && dir.length > 1) found.add(dir);
  }
  return [...found].sort((a, b) => a.length - b.length || a.localeCompare(b));
}

/** 路径对应的 SFTP / 终端工作目录（文件则取父目录）。 */
export function pathToRemoteDir(path: string): string {
  const cleaned = path.trim().replace(/^[`'"]+|[`'",;:]+$/g, "").replace(/^file:\/\//, "");
  if (!cleaned || cleaned === "/" || cleaned.startsWith("-")) return "/";
  if (cleaned.startsWith("/")) return normalizeRemotePath(cleaned);
  return "/";
}

export function shellCdCommand(dir: string): string {
  const safe = dir.replace(/'/g, `'\\''`);
  return `cd '${safe}'`;
}

export function buildProcessDirectoryList(input: {
  command?: string | null;
  cwd?: string | null;
  exe?: string | null;
  openFiles?: string[];
}): string[] {
  const found = new Set<string>();
  const add = (path: string | null | undefined, forceFile = false) => {
    if (!path) return;
    const dir = toDirectoryPath(path, input.cwd, forceFile);
    if (dir && dir.length > 1) found.add(dir);
  };

  add(input.cwd);
  add(input.exe, true);
  for (const dir of parsePathsFromCommand(input.command ?? "", input.cwd)) {
    add(dir);
  }
  for (const file of input.openFiles ?? []) {
    add(file, true);
  }

  return [...found].sort((a, b) => a.length - b.length || a.localeCompare(b));
}
