import { isAiThreadMessage, useBlocksStore } from "../../stores/blocksStore";

/** 从终端 inline AI block 的 aiThread 构建独立历史，避免污染侧栏主对话。 */
export function buildInlineAiHistoryJson(
  blockId: string,
  options?: { excludeLatestUser?: boolean },
): string | undefined {
  const block = useBlocksStore.getState().findBlockById(blockId);
  if (!block?.aiThread?.length) return undefined;

  const messages = block.aiThread.filter(isAiThreadMessage);
  if (messages.length === 0) return undefined;

  let selected = messages;
  if (options?.excludeLatestUser && selected[selected.length - 1]?.role === "user") {
    selected = selected.slice(0, -1);
  }
  if (selected.length === 0) return undefined;

  return JSON.stringify(
    selected.map((item) => ({
      role: item.role,
      content: item.content.trim(),
    })),
  );
}
