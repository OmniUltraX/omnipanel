import type { LocalShellSpec, TerminalSessionInfo } from "../../stores/terminalTypes";

/** 从 shellSpec / shellLabel 解析 WSL 发行版名 */
export function resolveWslDistroName(
  session: Pick<TerminalSessionInfo, "shellLabel" | "shellSpec"> | null | undefined,
): string | null {
  const spec = session?.shellSpec ?? null;
  if (spec?.kind === "wsl" && spec.wslDistro?.trim()) {
    return spec.wslDistro.trim();
  }
  const label = session?.shellLabel?.trim() ?? "";
  const m = label.match(/^(.+?)\s*\(WSL\)\s*$/i);
  if (m?.[1]?.trim()) return m[1].trim();
  if (/^wsl$/i.test(label)) return "Ubuntu";
  return null;
}

export function isWslLocalSession(
  session: Pick<TerminalSessionInfo, "type" | "shellLabel" | "shellSpec"> | null | undefined,
): boolean {
  if (!session || session.type !== "local") return false;
  if (session.shellSpec?.kind === "wsl") return true;
  return /\bwsl\b/i.test(session.shellLabel ?? "");
}

/**
 * 将 WSL 内 Linux 路径映射为 Windows 可访问路径。
 * - `/mnt/c/Users/...` → `C:\Users\...`
 * - `/home/...` → `\\wsl$\<Distro>\home\...`
 */
export function wslLinuxPathToWindowsPath(distro: string, linuxPath: string): string | null {
  const name = distro.trim();
  if (!name) return null;
  let p = linuxPath.trim().replace(/\\/g, "/");
  // `~` / `~/`：落到发行版 /home，由用户点进具体账号目录
  if (!p || p === "~" || p === "~/") return `\\\\wsl$\\${name}\\home`;
  if (p.startsWith("~/")) {
    // 无用户名时无法可靠展开，先落到 /home 再保留相对段（宁可进 /home/foo 也不回 Windows）
    p = `/home/${p.slice(2)}`;
  }
  if (!p.startsWith("/")) return null;

  const mnt = p.match(/^\/mnt\/([a-zA-Z])(?:\/(.*))?$/);
  if (mnt) {
    const drive = mnt[1]!.toUpperCase();
    const rest = (mnt[2] ?? "").replace(/\//g, "\\");
    return rest ? `${drive}:\\${rest}` : `${drive}:\\`;
  }

  if (p === "/") return `\\\\wsl$\\${name}`;
  const winTail = p.replace(/\//g, "\\");
  return `\\\\wsl$\\${name}${winTail}`;
}

/** 本地终端侧栏文件面板应打开的 Windows 路径；非 WSL 则原样返回 Windows cwd */
export function resolveLocalFilesPanelPath(
  session: Pick<TerminalSessionInfo, "type" | "cwd" | "shellLabel" | "shellSpec"> | null | undefined,
): string | null {
  if (!session || session.type !== "local") return null;
  const cwd = (session.cwd ?? "").trim();
  if (!cwd) return null;

  if (isWslLocalSession(session)) {
    const distro = resolveWslDistroName(session);
    if (!distro) return null;
    // 已是 \\wsl$ / \\wsl.localhost UNC：直接浏览
    const unc = cwd.replace(/\//g, "\\");
    if (/^\\\\wsl(?:\$|\.localhost)\\/i.test(unc)) return unc;
    // 盘符路径多半是切 shell 残留的 Windows cwd，对 WSL 无效 → 落到发行版 /home
    if (/^[A-Za-z]:[\\/]/.test(cwd)) {
      return wslLinuxPathToWindowsPath(distro, "~");
    }
    return wslLinuxPathToWindowsPath(distro, cwd);
  }

  // PowerShell / CMD：只同步明确 Windows 路径
  if (/^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith("\\\\")) {
    return cwd.replace(/\//g, "\\");
  }
  return null;
}

/** 供测试/调试：判断 shellSpec 是否 WSL */
export function shellSpecIsWsl(spec: LocalShellSpec | null | undefined): boolean {
  return spec?.kind === "wsl";
}
