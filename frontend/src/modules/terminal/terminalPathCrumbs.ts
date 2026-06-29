import { shellCdCommand } from "../server/ssh/utils/parseCommandPaths";

export type TerminalPathCrumb = {
  label: string;
  path: string;
};

/** 从已知 Windows 绝对路径或用户名推断用户主目录 */
export function resolveWindowsHomeDirectory(
  sessionUser?: string | null,
  ...hints: Array<string | null | undefined>
): string | null {
  for (const hint of hints) {
    if (!hint) continue;
    const normalized = hint.replace(/\//g, "\\");
    const match = /^([A-Za-z]:\\Users\\[^\\]+)/i.exec(normalized);
    if (match) return match[1]!;
  }
  if (sessionUser) return `C:\\Users\\${sessionUser}`;
  return null;
}

/** 将 ~/path 展开为绝对路径（Windows 本地终端优先） */
export function expandTildePath(
  path: string,
  sessionUser?: string | null,
  ...hints: Array<string | null | undefined>
): string {
  const trimmed = path.trim();
  if (!trimmed.startsWith("~")) return trimmed;

  const windowsHome = resolveWindowsHomeDirectory(sessionUser, ...hints);
  if (windowsHome) {
    if (trimmed === "~" || trimmed === "~/" || trimmed === "~\\") return windowsHome;
    if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
      const rest = trimmed.slice(2).replace(/\//g, "\\").replace(/^\\+/, "");
      return rest ? `${windowsHome}\\${rest}` : windowsHome;
    }
  }

  return resolveAbsoluteTerminalCwd(trimmed, sessionUser);
}

/** 将终端 cwd 解析为可用于 cd 的绝对路径（Unix 远程为主） */
export function resolveAbsoluteTerminalCwd(
  cwd: string | undefined | null,
  user?: string | null,
): string {
  const trimmed = (cwd ?? "").trim().replace(/\\/g, "/");
  if (!trimmed || trimmed === "~" || trimmed === "~/") {
    if (user === "root") return "/root";
    if (user) return `/home/${user}`;
    return "~";
  }
  if (trimmed.startsWith("~/")) {
    const home = user === "root" ? "/root" : user ? `/home/${user}` : "";
    return home ? `${home}${trimmed.slice(1)}` : trimmed;
  }
  return trimmed;
}

function splitUnixPath(absolutePath: string): TerminalPathCrumb[] {
  const normalized = absolutePath.replace(/\/+$/, "") || "/";
  if (normalized === "/") return [{ label: "/", path: "/" }];

  const parts = normalized.split("/").filter(Boolean);
  const crumbs: TerminalPathCrumb[] = [{ label: "/", path: "/" }];
  let acc = "";
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : `/${part}`;
    crumbs.push({ label: part, path: acc });
  }
  return crumbs;
}

function splitWindowsPath(path: string): TerminalPathCrumb[] {
  const normalized = path.replace(/\//g, "\\");
  const match = /^([A-Za-z]:)(\\(.*))?$/.exec(normalized);
  if (!match) return [{ label: path, path }];

  const drive = match[1]!;
  const rest = match[2]?.replace(/^\\/, "") ?? "";
  if (!rest) return [{ label: drive, path: drive }];

  const parts = rest.split("\\").filter(Boolean);
  const crumbs: TerminalPathCrumb[] = [{ label: drive, path: drive }];
  let acc = drive;
  for (const part of parts) {
    acc = `${acc}\\${part}`;
    crumbs.push({ label: part, path: acc });
  }
  return crumbs;
}

/** 生成终端路径面包屑（与 SFTP 路径分段一致） */
export function splitTerminalPathCrumbs(
  cwd: string | undefined | null,
  user?: string | null,
  sessionType: "local" | "remote" = "remote",
): TerminalPathCrumb[] {
  const raw = (cwd ?? "").trim();
  if (!raw) {
    return [{ label: "~", path: "~" }];
  }

  if (/^[A-Za-z]:[\\/]/.test(raw) || (sessionType === "local" && /^[A-Za-z]:/.test(raw))) {
    return splitWindowsPath(raw);
  }

  const absolute = resolveAbsoluteTerminalCwd(raw, user);
  if (absolute === "~" || absolute.startsWith("~/")) {
    return [{ label: absolute, path: absolute }];
  }
  if (absolute.startsWith("/")) {
    return splitUnixPath(absolute);
  }

  return [{ label: raw, path: raw }];
}

export function terminalCdCommand(path: string): string {
  if (/^[A-Za-z]:/.test(path) || path.includes("\\")) {
    const safe = path.replace(/'/g, "''");
    return `cd '${safe}'`;
  }
  return shellCdCommand(path);
}
