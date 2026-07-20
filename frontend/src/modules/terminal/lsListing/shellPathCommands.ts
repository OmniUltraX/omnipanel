/** Shell 路径引号（Unix / PowerShell 兼容） */
export function shellQuotePath(path: string): string {
  if (/^[A-Za-z]:/.test(path) || path.includes("\\")) {
    return `'${path.replace(/'/g, "''")}'`;
  }
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

export function isWindowsStylePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.includes("\\");
}

export function shellListDirCommand(path: string): string {
  const q = shellQuotePath(path);
  if (isWindowsStylePath(path)) return `Get-ChildItem -Force ${q}`;
  return `ls -la -- ${q}`;
}

export function shellViewFileCommand(path: string): string {
  const q = shellQuotePath(path);
  if (isWindowsStylePath(path)) return `Get-Content -TotalCount 100 ${q}`;
  return `head -n 100 -- ${q}`;
}

export function shellStatCommand(path: string): string {
  const q = shellQuotePath(path);
  if (isWindowsStylePath(path)) return `Get-Item ${q} | Format-List *`;
  return `stat -- ${q}`;
}

/** 目录用于 SFTP 跳转：文件取父目录 */
export function directoryForReveal(absolutePath: string, isDir: boolean): string {
  if (isDir) return absolutePath;
  if (isWindowsStylePath(absolutePath)) {
    const normalized = absolutePath.replace(/\//g, "\\");
    const idx = normalized.lastIndexOf("\\");
    if (idx <= 2) return normalized.slice(0, 3); // C:\
    return normalized.slice(0, idx);
  }
  if (absolutePath === "/") return "/";
  const trimmed = absolutePath.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx <= 0 ? "/" : trimmed.slice(0, idx);
}
