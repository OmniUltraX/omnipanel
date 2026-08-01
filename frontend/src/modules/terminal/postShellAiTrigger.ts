import { useBlocksStore, type TerminalBlock } from "../../stores/blocksStore";
import { isWarpDisplay } from "./terminalDisplayMode";
import { normalizeBlockCommand } from "./terminalOutputText";
import {
  buildPostShellAiQuery,
  shouldTriggerAiAfterShell,
} from "./commandInputRouting";
import { submitInlineFollowUp, submitInlineNaturalLanguage } from "./warpInlineAi";
import { useTerminalUiStore } from "./terminalUiStore";

type PendingUserShell = {
  command: string;
  registeredAt: number;
};

const pendingUserShells = new Map<string, PendingUserShell>();
const triggeredBlockIds = new Set<string>();

const PENDING_TTL_MS = 120_000;

function pendingKey(sessionId: string, command: string): string {
  return `${sessionId}::${normalizeBlockCommand(command)}`;
}

/**
 * 命令失败后自动触发 AI 的能力已禁用。
 *
 * 背景：原逻辑在命令退出码非 0（或输出含错误关键词）时直接发起 AI 会话，
 * 提示词为"命令执行失败，请分析原因并给出可执行的修复建议"。
 * 用户反馈此行为过于激进——输错一个命令就自动弹 AI，体验割裂。
 *
 * 当前状态：两个导出函数均为 no-op，调用点保留不变（便于将来恢复或改造）。
 * 若后续需要重新启用，建议改为"失败后弹轻量确认条询问用户是否需要 AI 分析"，
 * 而非恢复自动触发。改造点集中在本文件，无需改动 useTerminal / useTerminalTabDockPane。
 */
export function registerUserShellCommand(_sessionId: string, _command: string): void {
  return;
}

/** @deprecated 已禁用，保留以维持调用点签名兼容。未来改造见上方说明。 */
function _registerUserShellCommandImpl(sessionId: string, command: string): void {
  if (!isWarpDisplay(sessionId)) return;
  const normalized = normalizeBlockCommand(command);
  if (!normalized) return;

  const now = Date.now();
  for (const [key, entry] of pendingUserShells) {
    if (!key.startsWith(`${sessionId}::`) || now - entry.registeredAt < PENDING_TTL_MS) {
      continue;
    }
    pendingUserShells.delete(key);
  }

  pendingUserShells.set(pendingKey(sessionId, normalized), {
    command: normalized,
    registeredAt: now,
  });
}

function consumeUserShellCommand(sessionId: string, command: string): boolean {
  const normalized = normalizeBlockCommand(command);
  const key = pendingKey(sessionId, normalized);
  const entry = pendingUserShells.get(key);
  if (!entry) return false;
  pendingUserShells.delete(key);
  return Date.now() - entry.registeredAt <= PENDING_TTL_MS;
}

function hasRunningAi(sessionId: string): boolean {
  return useBlocksStore
    .getState()
    .getBlocks(sessionId)
    .some((block) => block.kind === "ai" && block.status === "running");
}

/**
 * OSC 133 命令结束时尝试根据 shell 结果自动触发 AI。
 * @deprecated 已禁用——见文件顶部说明。当前为 no-op。
 */
export function tryPostShellAiTrigger(_sessionId: string, _block: TerminalBlock): void {
  return;
}

/** @deprecated 原 implementation，保留供未来改造参考。 */
function _tryPostShellAiTriggerImpl(sessionId: string, block: TerminalBlock): void {
  if (!isWarpDisplay(sessionId)) return;
  if (block.kind === "ai") return;
  if (triggeredBlockIds.has(block.id)) return;
  if (!consumeUserShellCommand(sessionId, block.command)) return;
  if (!shouldTriggerAiAfterShell(block)) return;
  if (hasRunningAi(sessionId)) return;

  triggeredBlockIds.add(block.id);
  if (triggeredBlockIds.size > 200) {
    triggeredBlockIds.clear();
  }

  const query = buildPostShellAiQuery(block);
  const cwd = block.cwd?.trim() ?? "";
  const followUpBlockId =
    useTerminalUiStore.getState().expandedAiBlockIds[sessionId] ?? null;

  if (followUpBlockId) {
    void submitInlineFollowUp(sessionId, followUpBlockId, query, cwd);
    return;
  }

  void submitInlineNaturalLanguage(sessionId, query, cwd);
}
