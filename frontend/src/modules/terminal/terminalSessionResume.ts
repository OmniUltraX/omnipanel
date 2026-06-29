import { findTerminalPane } from "../../stores/terminalStore";
import { useBlocksStore } from "../../stores/blocksStore";
import { terminalCdCommand } from "./terminalPathCrumbs";

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

export function buildSessionResumeCdCommand(sessionId: string): string | null {
  const cwd = resolveSavedSessionCwd(sessionId);
  if (!cwd) return null;
  return terminalCdCommand(cwd);
}
