import {
  isAiThreadToolCall,
  type AiThreadToolCall,
  type TerminalBlock,
} from "../../stores/blocksStore";
import { OMNI_TERMINAL_RUN_TERMINAL_COMMAND } from "./ai/mcpTools";
import { getResolvedAiThread } from "./aiThreadBridge";
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

export function isInlineTerminalToolName(toolName: string): boolean {
  return (
    toolName === OMNI_TERMINAL_RUN_TERMINAL_COMMAND ||
    toolName.endsWith(`/${OMNI_TERMINAL_RUN_TERMINAL_COMMAND}`)
  );
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
        const command = resolveToolCallCommand(entry);
        if (!shouldRequireTerminalApproval(command, mode)) {
          continue;
        }
        return { blockId: block.id, item: entry };
      }
    }
  }
  return null;
}
