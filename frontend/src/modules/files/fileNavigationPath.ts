import { isComputerRoot, isWindowsLocalPath, LOCAL_COMPUTER_ROOT } from "./localFilesystem";
import { parentPath } from "./utils";

export type ParseNavigationPathOptions = {
  platform?: string;
  homePath?: string;
};

/** 将当前路径格式化为地址栏展示文本。 */
export function formatPathForInput(
  path: string,
  protocol: string,
  options?: ParseNavigationPathOptions,
): string {
  if (protocol === "local") {
    if (!path || path === "~") {
      return options?.homePath ?? "~";
    }
    if (isComputerRoot(path)) {
      return LOCAL_COMPUTER_ROOT;
    }
    return path;
  }
  if (protocol === "s3") {
    if (!path) return "/";
    return path.startsWith("/") ? path : `/${path}`;
  }
  return path || "/";
}

/** 解析用户在地址栏输入的路径。 */
export function parseFileNavigationPath(
  raw: string,
  protocol: string,
  options?: ParseNavigationPathOptions,
): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    if (protocol === "local") return "";
    if (protocol === "s3") return "";
    return "/";
  }

  if (protocol === "local") {
    if (trimmed === "~") return "";
    if (trimmed.startsWith("~/")) return trimmed;

    const isWindows =
      options?.platform === "windows" ||
      (!options?.platform && (trimmed.includes("\\") || /^[A-Za-z]:/.test(trimmed)));

    if (isWindows) {
      if (trimmed === "\\" || trimmed === "\\\\" || isComputerRoot(trimmed)) {
        return LOCAL_COMPUTER_ROOT;
      }
      let normalized = trimmed.replace(/\//g, "\\");
      if (/^[A-Za-z]:[^\\]/.test(normalized)) {
        normalized = normalized.replace(/^([A-Za-z]:)/, "$1\\");
      }
      if (/^[A-Za-z]:$/.test(normalized)) {
        return `${normalized}\\`;
      }
      return normalized;
    }

    if (trimmed === "/") return "/";
    return trimmed.startsWith("/") ? trimmed.replace(/\/+$/, "") || "/" : `/${trimmed}`;
  }

  if (protocol === "s3") {
    return trimmed.replace(/^\/+/, "").replace(/\/+$/, "");
  }

  let posix = trimmed.replace(/\\/g, "/");
  if (!posix.startsWith("/")) {
    posix = `/${posix}`;
  }
  if (posix === "/") return "/";
  return posix.replace(/\/+$/, "") || "/";
}

function navigationBasename(path: string, protocol: string): string {
  if (protocol === "local") {
    if (!path || isComputerRoot(path)) return "";
    if (isWindowsLocalPath(path)) {
      const normalized = path.replace(/\//g, "\\").replace(/\\+$/, "");
      const match = normalized.match(/^([A-Za-z]:)(?:\\(.*))?$/);
      if (!match) {
        const parts = normalized.split("\\").filter(Boolean);
        return parts[parts.length - 1] ?? "";
      }
      const rest = match[2];
      if (!rest) return "";
      const parts = rest.split("\\").filter(Boolean);
      return parts[parts.length - 1] ?? "";
    }
    const parts = path.split("/").filter(Boolean);
    return parts[parts.length - 1] ?? "";
  }
  if (protocol === "s3") {
    const trimmed = path.replace(/\/+$/, "");
    const idx = trimmed.lastIndexOf("/");
    return idx < 0 ? trimmed : trimmed.slice(idx + 1);
  }
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/** 将不存在或无法访问的路径拆成「存在的父目录 + 末段前缀」，供地址栏前缀回退。 */
export function splitPathForPrefixFallback(
  path: string,
  protocol: string,
): { parentPath: string; prefix: string } | null {
  const trimmed = path.trim();
  if (!trimmed) return null;
  if (protocol === "local" && isComputerRoot(trimmed)) return null;
  if (protocol === "s3") {
    if (!trimmed.replace(/\/+$/, "")) return null;
  } else if (protocol !== "local" && trimmed === "/") {
    return null;
  }

  const prefix = navigationBasename(trimmed, protocol);
  if (!prefix) return null;

  const parent = parentPath(trimmed, protocol);
  if (parent === trimmed) return null;

  return { parentPath: parent, prefix };
}

/** POSIX 远端路径：空视为根，折叠重复斜杠。 */
export function normalizeRemotePosixPath(path: string | undefined | null): string {
  const raw = (path ?? "").trim();
  if (!raw || raw === "/") return "/";
  return `/${raw.split("/").filter(Boolean).join("/")}`;
}

/** SFTP/FTP 连接的远端根；其它协议返回空串。 */
export function remoteConnectionRootPath(
  protocol: string,
  rootPath: string | undefined | null,
): string {
  if (protocol !== "sftp" && protocol !== "ftp") return "";
  return normalizeRemotePosixPath(rootPath);
}

/** 当前路径为空时回退到连接 rootPath，避免面包屑把 /home/gui-test 显示成 /。 */
export function effectiveRemoteBrowsePath(
  currentPath: string | undefined | null,
  rootPath: string,
): string {
  const current = (currentPath ?? "").trim();
  if (current) return normalizeRemotePosixPath(current);
  return rootPath || "/";
}

export function isRemotePathWithinRoot(path: string, rootPath: string): boolean {
  const root = normalizeRemotePosixPath(rootPath);
  const cur = normalizeRemotePosixPath(path);
  if (root === "/") return true;
  return cur === root || cur.startsWith(`${root}/`);
}

/** 不允许浏览连接 rootPath 之上的路径。 */
export function clampRemotePathToRoot(path: string, rootPath: string): string {
  const root = normalizeRemotePosixPath(rootPath);
  const cur = normalizeRemotePosixPath(path);
  return isRemotePathWithinRoot(cur, root) ? cur : root;
}

