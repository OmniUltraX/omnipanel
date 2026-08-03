import {
  isAiThreadToolCall,
  type AiThreadToolCall,
  type TerminalBlock,
} from "../../stores/blocksStore";
import { getResolvedAiThread } from "./aiThreadBridge";
import { getPendingInlineToolScope } from "./inlineToolBridge";
import { shouldRequireTerminalApproval } from "./terminalApprovalPolicy";
import { resolveTerminalApprovalMode } from "./terminalApprovalSettings";

function resolveToolCallCommand(item: AiThreadToolCall): string {
  const direct = item.command?.trim();
  if (direct) return direct;
  try {
    const parsed = JSON.parse(item.args) as { command?: string };
    if (typeof parsed.command === "string" && parsed.command.trim()) {
      return parsed.command.trim();
    }
  } catch {
    // ignore
  }
  return "";
}

/** 历史内联「终端跑命令」工具已移除；保留函数以免调用方断裂，恒为 false。 */
export function isInlineTerminalToolName(_toolName: string): boolean {
  return false;
}

export type ActiveInlineTerminalTool = {
  blockId: string;
  item: AiThreadToolCall;
};

/** 当前会话中待确认或执行中的内联终端工具调用（取最新一条，免审批命令不展示） */
export function findActiveInlineTerminalTool(
  blocks: TerminalBlock[],
  sessionId: string,
): ActiveInlineTerminalTool | null {
  const mode = resolveTerminalApprovalMode(sessionId);

  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block.kind !== "ai") continue;
    const thread = getResolvedAiThread(block);
    for (let j = thread.length - 1; j >= 0; j--) {
      const entry = thread[j];
      if (
        isAiThreadToolCall(entry) &&
        isInlineTerminalToolName(entry.toolName) &&
        (entry.status === "pending" || entry.status === "running")
      ) {
        const scope = getPendingInlineToolScope(block.id, entry.id);
        if (scope && scope.sessionId !== sessionId) continue;
        const command = resolveToolCallCommand(entry);
        if (
          command &&
          !shouldRequireTerminalApproval(command, mode, {
            conversationId: entry.conversationId,
            terminalSessionId: sessionId,
          })
        ) {
          continue;
        }
        return { blockId: block.id, item: entry };
      }
    }
  }
  return null;
}
