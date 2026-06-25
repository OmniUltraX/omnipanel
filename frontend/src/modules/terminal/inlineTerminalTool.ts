import {
  isAiThreadToolCall,
  type AiThreadToolCall,
  type TerminalBlock,
} from "../../stores/blocksStore";
import { getResolvedAiThread } from "./aiThreadBridge";

export function isInlineTerminalToolName(toolName: string): boolean {
  return (
    toolName === "run_terminal_command" || toolName.endsWith("/run_terminal_command")
  );
}

export type ActiveInlineTerminalTool = {
  blockId: string;
  item: AiThreadToolCall;
};

/** 当前会话中待确认或执行中的内联终端工具调用（取最新一条） */
export function findActiveInlineTerminalTool(
  blocks: TerminalBlock[],
): ActiveInlineTerminalTool | null {
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
        return { blockId: block.id, item: entry };
      }
    }
  }
  return null;
}
