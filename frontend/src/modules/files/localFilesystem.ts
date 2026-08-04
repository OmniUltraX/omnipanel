import type { FileLocalSystemInfo } from "../../ipc/bindings";

/** Windows「此电脑」虚拟根路径（列出盘符）。 */
export const LOCAL_COMPUTER_ROOT = "\\\\";

export type LocalPlatform = FileLocalSystemInfo["platform"];

export function isComputerRoot(path: string): boolean {
  return path === LOCAL_COMPUTER_ROOT || path === "\\";
}

export function isWindowsLocalPath(path: string, platform?: string): boolean {
  if (platform === "windows") return true;
  return path.includes("\\") || /^[A-Za-z]:/.test(path);
}

function splitWindowsPath(path: string): string[] {
  const normalized = path.replace(/\//g, "\\").replace(/\\+$/, "");
  // UNC：\\wsl$\Ubuntu\home\... → ["\\\\wsl$", "Ubuntu", "home", ...]
  if (normalized.startsWith("\\\\")) {
    const rest = normalized.slice(2);
    const parts = rest.split("\\").filter(Boolean);
    if (parts.length === 0) return [];
    return [`\\\\${parts[0]}`, ...parts.slice(1)];
  }
  const match = normalized.match(/^([A-Za-z]:)(?:\\(.*))?$/);
  if (!match) {
    return normalized.split("\\").filter(Boolean);
  }
  const [, drive, rest] = match;
  if (!rest) return [drive!];
  return [drive!, ...rest.split("\\").filter(Boolean)];
}

function joinWindowsPath(parts: string[]): string {
  if (parts.length === 0) return LOCAL_COMPUTER_ROOT;
  if (parts[0]?.startsWith("\\\\")) {
    // UNC：\\server\share\...
    if (parts.length === 1) return `${parts[0]}\\`;
    return `${parts[0]}\\${parts.slice(1).join("\\")}`;
  }
  if (parts.length === 1) return `${parts[0]}\\`;
  return `${parts[0]}\\${parts.slice(1).join("\\")}`;
}

/** 本机路径上一级。Windows 盘符根的上级为「此电脑」。 */
export function parentLocalPath(path: string, platform?: string): string {
  if (isWindowsLocalPath(path, platform)) {
    if (isComputerRoot(path)) return path;
    const parts = splitWindowsPath(path);
    if (parts.length === 0) return LOCAL_COMPUTER_ROOT;
    // UNC：\\server\share 再上一级回到「此电脑」
    if (parts[0]?.startsWith("\\\\")) {
      if (parts.length <= 2) return LOCAL_COMPUTER_ROOT;
      return joinWindowsPath(parts.slice(0, -1));
    }
    if (parts.length <= 1) return LOCAL_COMPUTER_ROOT;
    return joinWindowsPath(parts.slice(0, -1));
  }
  if (path === "/" || !path || path === "~") return "/";
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 1) return "/";
  return `/${parts.slice(0, -1).join("/")}`;
}

/** 是否已处于本机浏览根（Windows 此电脑 / Unix 根目录）。 */
export function isLocalAtRoot(
  path: string,
  systemInfo: Pick<FileLocalSystemInfo, "platform" | "computerRoot"> | null | undefined,
): boolean {
  if (!systemInfo) {
    return isWindowsLocalPath(path) ? isComputerRoot(path) : path === "/" || !path;
  }
  if (systemInfo.platform === "windows") {
    return isComputerRoot(path);
  }
  return path === "/" || path === systemInfo.computerRoot;
}

/** 当前 Windows 盘符（如 `C:`），非 Windows 路径返回 null。 */
export function currentLocalDrive(path: string): string | null {
  const match = path.match(/^([A-Za-z]:)/);
  return match ? match[1]! : null;
}

export function splitLocalBreadcrumb(
  path: string,
  labels: { computer: string; home: string; root: string },
  systemInfo?: Pick<FileLocalSystemInfo, "platform" | "computerRoot"> | null,
): { label: string; path: string }[] {
  if (!path || path === "~") {
    return [{ label: labels.home, path: "" }];
  }

  if (systemInfo?.platform === "windows" || isWindowsLocalPath(path, systemInfo?.platform)) {
    if (isComputerRoot(path)) {
      return [{ label: labels.computer, path: LOCAL_COMPUTER_ROOT }];
    }
    const parts = splitWindowsPath(path);
    const crumbs: { label: string; path: string }[] = [
      { label: labels.computer, path: LOCAL_COMPUTER_ROOT },
    ];
    for (let i = 0; i < parts.length; i++) {
      crumbs.push({
        label: parts[i]!,
        path: joinWindowsPath(parts.slice(0, i + 1)),
      });
    }
    return crumbs;
  }

  if (path === "/") {
    return [{ label: labels.root, path: "/" }];
  }
  const parts = path.split("/").filter(Boolean);
  const crumbs: { label: string; path: string }[] = [{ label: labels.root, path: "/" }];
  let acc = "";
  for (const part of parts) {
    acc = `${acc}/${part}`;
    crumbs.push({ label: part, path: acc });
  }
  return crumbs;
}
