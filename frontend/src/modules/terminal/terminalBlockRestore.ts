import type { AiThreadItem, TerminalBlock } from "../../stores/blocksStore";
import type { PersistedTerminalBlock } from "../../stores/terminalHistoryStore";

function hasAiAssistantContent(thread: AiThreadItem[] | undefined): boolean {
  return (thread ?? []).some(
    (item) =>
      item.kind === "message" &&
      item.role === "assistant" &&
      Boolean(item.content.trim() || item.reasoning?.trim()),
  );
}

/** 会话恢复 / 重连时，将遗留的 running 块收尾为终态 */
export function normalizeStaleRunningBlock(block: TerminalBlock): TerminalBlock {
  if (block.status !== "running") {
    if (block.kind === "ai" && block.status === "completed" && hasAiAssistantContent(block.aiThread)) {
      return { ...block, exitCode: 0, aiStalled: false };
    }
    return block;
  }

  const completedAt = block.completedAt ?? Date.now();

  if (block.kind === "ai") {
    const hasContent = hasAiAssistantContent(block.aiThread);
    return {
      ...block,
      status: hasContent ? "completed" : "failed",
      exitCode: hasContent ? 0 : 1,
      completedAt,
      aiStalled: false,
    };
  }

  if (block.silent) {
    return {
      ...block,
      status: "completed",
      exitCode: 0,
      completedAt,
    };
  }

  return {
    ...block,
    status: "completed",
    exitCode: block.exitCode ?? 0,
    completedAt,
  };
}

export function normalizeRestoredTerminalBlock(block: PersistedTerminalBlock): TerminalBlock {
  return normalizeStaleRunningBlock({
    ...block,
    marker: null,
  });
}

export function reconcileStaleRunningBlocks(_sessionId: string, blocks: TerminalBlock[]): TerminalBlock[] {
  return blocks.map(normalizeStaleRunningBlock);
}
