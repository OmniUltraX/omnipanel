import type { AiThreadItem, TerminalBlock } from "../../stores/blocksStore";
import type { PersistedTerminalBlock } from "../../stores/terminalHistoryStore";

const STALE_INLINE_TOOL_RESULT = "审批已失效（会话已中断或已恢复）";

function hasAiAssistantContent(thread: AiThreadItem[] | undefined): boolean {
  return (thread ?? []).some(
    (item) =>
      item.kind === "message" &&
      item.role === "assistant" &&
      Boolean(item.content.trim() || item.reasoning?.trim()),
  );
}

/** 关闭历史中残留的待确认/执行中工具调用（内存 pending Map 无法跨会话恢复） */
export function closeStaleAiThreadToolCalls(
  thread: AiThreadItem[] | undefined,
  result = STALE_INLINE_TOOL_RESULT,
): AiThreadItem[] | undefined {
  if (!thread?.length) return thread;
  let changed = false;
  const next = thread.map((item) => {
    if (item.kind !== "tool_call") return item;
    if (item.status !== "pending" && item.status !== "running") return item;
    changed = true;
    return {
      ...item,
      status: "rejected" as const,
      result: item.result?.trim() ? item.result : result,
    };
  });
  return changed ? next : thread;
}

/** 会话恢复 / 重连时，将遗留的 running 块收尾为终态 */
export function normalizeStaleRunningBlock(block: TerminalBlock): TerminalBlock {
  const closedThread = closeStaleAiThreadToolCalls(block.aiThread);
  const withClosedTools =
    closedThread === block.aiThread ? block : { ...block, aiThread: closedThread };

  if (withClosedTools.status !== "running") {
    if (
      withClosedTools.kind === "ai" &&
      withClosedTools.status === "completed" &&
      hasAiAssistantContent(withClosedTools.aiThread)
    ) {
      return { ...withClosedTools, exitCode: 0, aiStalled: false };
    }
    return withClosedTools;
  }

  const completedAt = withClosedTools.completedAt ?? Date.now();

  if (withClosedTools.kind === "ai") {
    const hasContent = hasAiAssistantContent(withClosedTools.aiThread);
    return {
      ...withClosedTools,
      status: hasContent ? "completed" : "failed",
      exitCode: hasContent ? 0 : 1,
      completedAt,
      aiStalled: false,
    };
  }

  if (withClosedTools.silent) {
    return {
      ...withClosedTools,
      status: "completed",
      exitCode: 0,
      completedAt,
    };
  }

  return {
    ...withClosedTools,
    status: "completed",
    exitCode: withClosedTools.exitCode ?? 0,
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
