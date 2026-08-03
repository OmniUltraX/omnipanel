import {
  isAiThreadToolCall,
  type AiThreadToolCall,
  type TerminalBlock,
} from "../../stores/blocksStore";
import { SSH_EXEC_TOOL_NAME } from "../../lib/ai/toolHost";
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

/** 在终端会话内联展示 / 审批的「跑命令」类工具（含历史别名）。 */
const INLINE_TERMINAL_TOOL_NAMES = new Set([
  SSH_EXEC_TOOL_NAME,
  "omni_terminal_run_terminal_command",
  "run_terminal_command",
]);

export function isInlineTerminalToolName(toolName: string): boolean {
  return INLINE_TERMINAL_TOOL_NAMES.has(toolName);
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
        const scope = getPendingInlineToolScope(entry.id, sessionId);
        if (scope.terminalSessionId && scope.terminalSessionId !== sessionId) continue;
        const command = resolveToolCallCommand(entry);
        if (
          command &&
          !shouldRequireTerminalApproval(command, mode, {
            conversationId: scope.conversationId,
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
