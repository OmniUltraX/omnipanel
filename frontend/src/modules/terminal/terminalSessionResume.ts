import { findTerminalPane } from "../../stores/terminalStore";
import { useBlocksStore } from "../../stores/blocksStore";
import { terminalCdCommand } from "./terminalPathCrumbs";
import { resolveTerminalShellFamily } from "./terminalAutoLsShell";

/** 是否可作为「上次工作目录」恢复 */
export function isRestorableSessionCwd(cwd: string | null | undefined): boolean {
  const trimmed = (cwd ?? "").trim();
  if (!trimmed || trimmed === "~" || trimmed === "~/") return false;
  if (trimmed === "~/workspace" || trimmed === "~/workspace/") return false;
  return true;
}

/** 从会话元数据读取已保存的工作目录 */
export function resolveSavedSessionCwd(sessionId: string): string | null {
  const pane = findTerminalPane(sessionId);
  const cwd = pane?.cwd?.trim();
  if (!cwd || !isRestorableSessionCwd(cwd)) return null;
  return cwd;
}

/** 是否曾使用过（有历史 block 或已记录工作目录） */
export function isReturningTerminalSession(sessionId: string): boolean {
  if (useBlocksStore.getState().getBlocks(sessionId).length > 0) return true;
  return resolveSavedSessionCwd(sessionId) !== null;
}

/**
 * 判断路径风格是否与目标 shell 兼容。
 *
 * WSL(bash) 的 cwd 是 Unix 路径（/root, /home/user），PowerShell 的 cwd 是
 * Windows 路径（C:\Users\...）。当 backend 切换导致 shell 类型变化时，
 * 旧 cwd 对新 shell 无意义且会触发报错（如 `cd '/root'` 在 PowerShell 里
 * 被解析成 `C:\root` 报"找不到路径"），此时应跳过恢复。
 */
function isCwdCompatibleWithShell(cwd: string, shell: ReturnType<typeof resolveTerminalShellFamily>): boolean {
  const isUnixPath = cwd.startsWith("/") || cwd.startsWith("~");
  const isWinPath = /^[A-Za-z]:[\\/]/.test(cwd);
  if (shell === "powershell" || shell === "cmd") {
    return !isUnixPath;
  }
  // posix (bash/zsh/fish/wsl)
  return !isWinPath;
}

export function buildSessionResumeCdCommand(sessionId: string): string | null {
  const pane = findTerminalPane(sessionId);
  const cwd = pane?.cwd?.trim();
  if (!cwd || !isRestorableSessionCwd(cwd)) return null;
  const shell = resolveTerminalShellFamily(
    pane?.type ?? "local",
    pane?.shellLabel,
    pane?.shellSpec,
  );
  // shell 类型与路径风格不兼容时跳过恢复（如 WSL 的 /root 恢复到 PowerShell）
  if (!isCwdCompatibleWithShell(cwd, shell)) return null;
  return terminalCdCommand(cwd);
}
