import {
  isAiThreadMessage,
  isAiThreadToolCall,
  useBlocksStore,
  type AiThreadItem,
  type AiThreadMessage,
  type AiThreadToolCall,
} from "../../stores/blocksStore";
import { getResolvedAiThread } from "./aiThreadBridge";
import {
  INLINE_AI_FALLBACK_MAX_MESSAGES,
  INLINE_AI_RECENT_TURN_COUNT,
  INLINE_AI_SUMMARY_TRIGGER_COUNT,
} from "./inlineAiHistoryConfig";

type HistoryMessage = { role: "user" | "assistant" | "system"; content: string };

export type InlineAiHistoryOptions = {
  excludeLatestUser?: boolean;
  /** 同终端会话内更早的 AI 卡片一并带上，避免新开 block 后「继续」没有上下文 */
  sessionId?: string;
};

const TOOL_RESULT_HISTORY_MAX = 2000;

function toHistoryMessages(messages: AiThreadMessage[]): HistoryMessage[] {
  return messages
    .map((item) => ({
      role: item.role,
      content: item.content.trim(),
    }))
    .filter((item) => item.content.length > 0);
}

function countTurns(messages: AiThreadMessage[]): number {
  return messages.filter((item) => item.role === "user").length;
}

function sliceRecentTurns(messages: AiThreadMessage[], turnCount: number): AiThreadMessage[] {
  if (turnCount <= 0 || messages.length === 0) return [];
  let turns = 0;
  let startIndex = messages.length;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user") {
      turns += 1;
      startIndex = i;
      if (turns >= turnCount) break;
    }
  }
  return messages.slice(startIndex);
}

function formatToolCallHistory(item: AiThreadToolCall): string {
  const cmd = item.command?.trim() || item.toolName;
  const statusLabel = item.status === "completed" ? "完成" : item.status;
  const lines = [`[工具 ${item.toolName} · ${statusLabel}] ${cmd}`];
  const result = item.result?.trim();
  if (result) {
    lines.push(result.length > TOOL_RESULT_HISTORY_MAX ? `${result.slice(0, TOOL_RESULT_HISTORY_MAX)}\n…` : result);
  }
  return lines.join("\n");
}

function flattenItemsToMessages(items: AiThreadItem[]): AiThreadMessage[] {
  const out: AiThreadMessage[] = [];
  for (const item of items) {
    if (isAiThreadMessage(item)) {
      const content =
        item.content.trim() ||
        (item.reasoning?.trim() ? `[思考]\n${item.reasoning.trim()}` : "");
      if (!content) continue;
      out.push(content === item.content.trim() ? item : { ...item, content });
      continue;
    }
    if (!isAiThreadToolCall(item) || item.status === "rejected") continue;
    const text = formatToolCallHistory(item);
    if (!text.trim()) continue;
    out.push({
      kind: "message",
      id: `hist-tool-${item.id}`,
      role: "assistant",
      content: text,
      timestamp: item.timestamp,
    });
  }
  return out;
}

function collectInlineHistoryItems(blockId: string, sessionId?: string): AiThreadItem[] {
  const store = useBlocksStore.getState();
  const items: AiThreadItem[] = [];
  if (sessionId) {
    const blocks = store.blocks[sessionId] ?? [];
    for (const block of blocks) {
      if (block.kind !== "ai" || block.id === blockId) continue;
      items.push(...getResolvedAiThread(block));
    }
  }
  const current = store.findBlockById(blockId);
  if (current) items.push(...getResolvedAiThread(current));
  return items;
}

function collectHistoryMessages(
  blockId: string,
  options?: InlineAiHistoryOptions,
): AiThreadMessage[] {
  let messages = flattenItemsToMessages(collectInlineHistoryItems(blockId, options?.sessionId));
  if (options?.excludeLatestUser && messages[messages.length - 1]?.role === "user") {
    messages = messages.slice(0, -1);
  }
  return messages;
}

function buildSummaryPrompt(olderMessages: AiThreadMessage[]): { system: string; user: string } {
  const transcript = olderMessages
    .map((item) => `${item.role === "user" ? "用户" : "助手"}: ${item.content.trim()}`)
    .join("\n\n");

  return {
    system:
      "你是终端内联 AI 对话的历史摘要助手。将更早的对话压缩为简洁摘要，保留关键命令、路径、结论与未完成任务。使用中文，不超过 800 字。",
    user: `请摘要以下更早的对话轮次：\n\n${transcript}`,
  };
}

async function summarizeOlderMessages(
  blockId: string,
  olderMessages: AiThreadMessage[],
  messageCount: number,
): Promise<string | null> {
  if (olderMessages.length === 0) return null;

  const block = useBlocksStore.getState().findBlockById(blockId);
  if (
    block?.aiThreadSummary &&
    block.aiThreadSummaryForCount === messageCount
  ) {
    return block.aiThreadSummary;
  }

  const { system, user } = buildSummaryPrompt(olderMessages);
  const { requestAiCompletionOnce } = await import("../../lib/ai/requestAiCompletionOnce");
  const result = await requestAiCompletionOnce({
    system,
    user,
    maxTokens: 600,
    temperature: 0.2,
    // oneshot 纯文本补全：禁用推理模型思考链回退
    pureText: true,
  });

  if (!result.ok) return null;

  useBlocksStore.getState().updateBlock(blockId, {
    aiThreadSummary: result.content,
    aiThreadSummaryForCount: messageCount,
  });

  return result.content;
}

function fallbackTruncate(messages: AiThreadMessage[]): HistoryMessage[] {
  const selected =
    messages.length > INLINE_AI_FALLBACK_MAX_MESSAGES
      ? messages.slice(-INLINE_AI_FALLBACK_MAX_MESSAGES)
      : messages;
  return toHistoryMessages(selected);
}

function historyFromMessages(
  messages: AiThreadMessage[],
  blockId: string,
  mode: "sync" | "async",
): HistoryMessage[] | Promise<HistoryMessage[]> {
  if (messages.length === 0) return mode === "sync" ? [] : Promise.resolve([]);

  if (messages.length <= INLINE_AI_SUMMARY_TRIGGER_COUNT) {
    const history = toHistoryMessages(messages);
    return mode === "sync" ? history : Promise.resolve(history);
  }

  const recent = sliceRecentTurns(messages, INLINE_AI_RECENT_TURN_COUNT);
  const recentStartId = recent[0]?.id;
  const older = recentStartId
    ? messages.slice(0, messages.findIndex((m) => m.id === recentStartId))
    : [];

  if (mode === "sync") {
    const block = useBlocksStore.getState().findBlockById(blockId);
    if (block?.aiThreadSummary && block.aiThreadSummaryForCount === messages.length) {
      return [
        { role: "system", content: `[更早对话摘要]\n${block.aiThreadSummary}` },
        ...toHistoryMessages(recent),
      ];
    }
    if (older.length > 0) return fallbackTruncate(messages);
    return toHistoryMessages(recent);
  }

  return summarizeOlderMessages(blockId, older, messages.length).then((summary) => {
    if (summary) {
      return [
        { role: "system", content: `[更早对话摘要]\n${summary}` },
        ...toHistoryMessages(recent),
      ];
    }
    return fallbackTruncate(messages);
  });
}

/** 从终端 inline AI block 的 aiThread 构建独立历史，支持滑动窗口 + AI 摘要压缩。 */
export async function buildInlineAiHistoryJson(
  blockId: string,
  options?: InlineAiHistoryOptions,
): Promise<string | undefined> {
  const messages = collectHistoryMessages(blockId, options);
  if (messages.length === 0) return undefined;
  const history = await historyFromMessages(messages, blockId, "async");
  if (history.length === 0) return undefined;
  return JSON.stringify(history);
}

/** 同步版：测试与无摘要场景使用（不触发 AI 摘要） */
export function buildInlineAiHistoryJsonSync(
  blockId: string,
  options?: InlineAiHistoryOptions,
): string | undefined {
  const messages = collectHistoryMessages(blockId, options);
  if (messages.length === 0) return undefined;
  const history = historyFromMessages(messages, blockId, "sync") as HistoryMessage[];
  if (history.length === 0) return undefined;
  return JSON.stringify(history);
}

export { countTurns, sliceRecentTurns };
