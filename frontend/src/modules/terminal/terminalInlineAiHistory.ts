import { isAiThreadMessage, useBlocksStore, type AiThreadMessage } from "../../stores/blocksStore";
import {
  INLINE_AI_FALLBACK_MAX_MESSAGES,
  INLINE_AI_RECENT_TURN_COUNT,
  INLINE_AI_SUMMARY_TRIGGER_COUNT,
} from "./inlineAiHistoryConfig";

type HistoryMessage = { role: "user" | "assistant" | "system"; content: string };

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

/** 从终端 inline AI block 的 aiThread 构建独立历史，支持滑动窗口 + AI 摘要压缩。 */
export async function buildInlineAiHistoryJson(
  blockId: string,
  options?: { excludeLatestUser?: boolean },
): Promise<string | undefined> {
  const block = useBlocksStore.getState().findBlockById(blockId);
  if (!block?.aiThread?.length) return undefined;

  let messages = block.aiThread.filter(isAiThreadMessage);
  if (messages.length === 0) return undefined;

  if (options?.excludeLatestUser && messages[messages.length - 1]?.role === "user") {
    messages = messages.slice(0, -1);
  }
  if (messages.length === 0) return undefined;

  let history: HistoryMessage[];

  if (messages.length <= INLINE_AI_SUMMARY_TRIGGER_COUNT) {
    history = toHistoryMessages(messages);
  } else {
    const recent = sliceRecentTurns(messages, INLINE_AI_RECENT_TURN_COUNT);
    const recentStartId = recent[0]?.id;
    const older = recentStartId
      ? messages.slice(0, messages.findIndex((m) => m.id === recentStartId))
      : [];

    const summary = await summarizeOlderMessages(blockId, older, messages.length);
    if (summary) {
      history = [
        { role: "system", content: `[更早对话摘要]\n${summary}` },
        ...toHistoryMessages(recent),
      ];
    } else {
      history = fallbackTruncate(messages);
    }
  }

  if (history.length === 0) return undefined;

  return JSON.stringify(history);
}

/** 同步版：测试与无摘要场景使用（不触发 AI 摘要） */
export function buildInlineAiHistoryJsonSync(
  blockId: string,
  options?: { excludeLatestUser?: boolean },
): string | undefined {
  const block = useBlocksStore.getState().findBlockById(blockId);
  if (!block?.aiThread?.length) return undefined;

  let messages = block.aiThread.filter(isAiThreadMessage);
  if (messages.length === 0) return undefined;

  if (options?.excludeLatestUser && messages[messages.length - 1]?.role === "user") {
    messages = messages.slice(0, -1);
  }
  if (messages.length === 0) return undefined;

  let history: HistoryMessage[];

  if (messages.length <= INLINE_AI_SUMMARY_TRIGGER_COUNT) {
    history = toHistoryMessages(messages);
  } else {
    const recent = sliceRecentTurns(messages, INLINE_AI_RECENT_TURN_COUNT);
    const recentStartId = recent[0]?.id;
    const older = recentStartId
      ? messages.slice(0, messages.findIndex((m) => m.id === recentStartId))
      : [];

    if (block.aiThreadSummary && block.aiThreadSummaryForCount === messages.length) {
      history = [
        { role: "system", content: `[更早对话摘要]\n${block.aiThreadSummary}` },
        ...toHistoryMessages(recent),
      ];
    } else if (older.length > 0) {
      history = fallbackTruncate(messages);
    } else {
      history = toHistoryMessages(recent);
    }
  }

  if (history.length === 0) return undefined;
  return JSON.stringify(history);
}

export { countTurns, sliceRecentTurns };
