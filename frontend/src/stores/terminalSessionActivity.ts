import type { TerminalBlock } from "./blocksStore";
import { isInternalHistoryCommand } from "../modules/terminal/commandBar/internalHistoryCommands";
import {
  isSilentHistorySync,
  isSilentHistorySyncCommand,
} from "../modules/terminal/commandBar/shellHistorySync";
import { useTerminalStore } from "./terminalStore";
import type { TerminalSession } from "./terminalSessionModel";

export type RecordTerminalSessionActivityOptions = {
  command?: string;
};

/** 是否应计入会话「最后命令/输出」时间（排除历史同步、注入脚本、重连/bootstrap 等内部流量） */
export function shouldRecordTerminalSessionActivity(
  sessionId: string,
  options?: RecordTerminalSessionActivityOptions,
): boolean {
  if (!sessionId) return false;
  if (isSilentHistorySync(sessionId)) return false;
  const command = options?.command?.trim();
  if (command) {
    if (isSilentHistorySyncCommand(command)) return false;
    if (isInternalHistoryCommand(command)) return false;
  }
  return true;
}

function isMeaningfulShellActivityBlock(block: TerminalBlock): boolean {
  if (block.kind === "ai") return false;
  const command = block.command?.trim() ?? "";
  if (!command) return false;
  if (isSilentHistorySyncCommand(command)) return false;
  if (isInternalHistoryCommand(command)) return false;
  return true;
}

/** 记录会话最后一次命令/输出活动时间（与 tab 聚焦、重连无关） */
export function recordTerminalSessionActivity(
  sessionId: string,
  at = Date.now(),
  options?: RecordTerminalSessionActivityOptions,
): void {
  if (!sessionId || !Number.isFinite(at)) return;
  if (!shouldRecordTerminalSessionActivity(sessionId, options)) return;
  useTerminalStore.getState().touchSession(sessionId, at);
}

export function resolveSessionActivityAt(
  session: TerminalSession,
  blocksBySession: Record<string, TerminalBlock[]>,
): number {
  const blocks = blocksBySession[session.id] ?? [];
  let best = session.lastActiveAt;
  for (const block of blocks) {
    if (!isMeaningfulShellActivityBlock(block)) continue;
    const candidate = block.completedAt ?? block.timestamp;
    if (candidate > best) best = candidate;
  }
  return best > 0 ? best : session.createdAt;
}
