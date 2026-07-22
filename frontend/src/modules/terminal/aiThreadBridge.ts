import type { ThreadMessage } from "@assistant-ui/react";
import {
  normalizeAiMessage,
  type AiMessage,
  type AiMessagePart,
  type ToolCallState,
} from "../../stores/aiStore";
import { aiMessagesToThreadMessages } from "../../components/ai/assistant-ui/messageBridge";
import type { AiThreadItem, AiThreadMessage, AiThreadToolCall, TerminalBlock } from "../../stores/blocksStore";
import { isAiThreadMessage, isAiThreadToolCall, useBlocksStore } from "../../stores/blocksStore";
import { buildAiThreadItemSignature } from "./threadSignature";

export interface ModelPriorMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: {
    id: string;
    name: string;
    arguments: string;
    result: string | undefined;
  }[];
}

function normalizeItem(raw: AiThreadItem | (Omit<AiThreadMessage, "kind"> & { kind?: string })): AiThreadItem {
  if ("kind" in raw && raw.kind === "tool_call") return raw as AiThreadItem;
  if ("kind" in raw && raw.kind === "message") return raw as AiThreadItem;
  const legacy = raw as Omit<AiThreadMessage, "kind">;
  return {
    kind: "message",
    id: legacy.id,
    role: legacy.role,
    content: legacy.content,
    reasoning: legacy.reasoning,
    timestamp: legacy.timestamp,
  };
}

export function normalizeAiThread(thread: AiThreadItem[] | undefined): AiThreadItem[] {
  const items = (thread ?? []).map((item) => normalizeItem(item));
  const seen = new Set<string>();
  return items.map((item, index) => {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      return item;
    }
    const nextId = `${item.id}__${index}`;
    seen.add(nextId);
    return { ...item, id: nextId };
  });
}

export function getResolvedAiThread(block: TerminalBlock): AiThreadItem[] {
  const thread = normalizeAiThread(block.aiThread);
  if (thread.length > 0) return thread;
  if (block.kind !== "ai") return thread;

  const migrated: AiThreadItem[] = [];
  const legacyPrefix = block.id;
  if (block.title?.trim()) {
    migrated.push({
      kind: "message",
      id: `${legacyPrefix}-legacy-user`,
      role: "user",
      content: block.title.trim(),
      timestamp: block.timestamp,
    });
  }
  if (block.reasoning?.trim() || block.output.trim()) {
    migrated.push({
      kind: "message",
      id: `${legacyPrefix}-legacy-assistant`,
      role: "assistant",
      content: block.output.trim(),
      reasoning: block.reasoning?.trim(),
      timestamp: block.timestamp + 1,
    });
  }
  return migrated;
}

function mapToolStatus(status: AiThreadToolCall["status"]): ToolCallState["status"] {
  if (status === "pending" || status === "running") return "running";
  if (status === "completed") return "completed";
  return "failed";
}

function toolCallToPart(toolCall: AiThreadToolCall): AiMessagePart {
  return {
    type: "tool-call",
    id: toolCall.id,
    name: toolCall.toolName,
    arguments: toolCall.args,
    result: toolCall.result,
    status: mapToolStatus(toolCall.status),
  };
}

function assistantMessageParts(
  item: AiThreadMessage,
  followingTools: AiThreadToolCall[],
): AiMessagePart[] {
  // parts 存在且非空时直接使用（保序：思考→文本→工具→再思考→再文本）
  // tool-call 边界已在流式写入时以 tool-call part 形式插入 parts，无需再追加 followingTools
  if (item.parts && item.parts.length > 0) {
    return item.parts;
  }
  // 回退：旧数据无 parts，按固定顺序拼 reasoning + content + tools
  const parts: AiMessagePart[] = [];
  if (item.reasoning?.trim()) {
    parts.push({ type: "reasoning", text: item.reasoning.trim() });
  }
  if (item.content) {
    parts.push({ type: "text", text: item.content });
  }
  for (const tool of followingTools) {
    parts.push(toolCallToPart(tool));
  }
  return parts;
}

/** 将终端 AI 线程转为侧栏 AI 助手同款 AiMessage 列表（保序 parts） */
export function aiThreadToAiMessages(
  thread: AiThreadItem[],
  options?: { isStreaming?: boolean },
): AiMessage[] {
  const items = normalizeAiThread(thread);
  const messages: AiMessage[] = [];

  let streamingAssistantId: string | null = null;
  if (options?.isStreaming) {
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i];
      if (isAiThreadMessage(item) && item.role === "assistant") {
        streamingAssistantId = item.id;
        break;
      }
    }
  }

  let index = 0;
  while (index < items.length) {
    const item = items[index];
    if (isAiThreadMessage(item)) {
      if (item.role === "user") {
        messages.push(
          normalizeAiMessage({
            id: item.id,
            role: "user",
            content: item.content,
            parts: item.content ? [{ type: "text", text: item.content }] : [],
            timestamp: item.timestamp ?? Date.now(),
          }),
        );
        index += 1;
        continue;
      }

      const followingTools: AiThreadToolCall[] = [];
      index += 1;
      while (index < items.length && isAiThreadToolCall(items[index])) {
        followingTools.push(items[index] as AiThreadToolCall);
        index += 1;
      }

      const parts = assistantMessageParts(item, followingTools);
      messages.push(
        normalizeAiMessage({
          id: item.id,
          role: "assistant",
          content: item.content,
          reasoningContent: item.reasoning?.trim() || undefined,
          parts,
          timestamp: item.timestamp ?? Date.now(),
          isStreaming: item.id === streamingAssistantId,
          isReasoningStreaming:
            item.id === streamingAssistantId &&
            !item.content.trim() &&
            (Boolean(item.reasoning?.trim()) || Boolean(options?.isStreaming)),
        }),
      );
      continue;
    }

    if (isAiThreadToolCall(item)) {
      messages.push(
        normalizeAiMessage({
          id: `tool-wrap-${item.id}`,
          role: "assistant",
          content: "",
          parts: [toolCallToPart(item)],
          timestamp: Date.now(),
        }),
      );
      index += 1;
      continue;
    }

    index += 1;
  }

  return messages;
}

/** 转为 assistant-ui ThreadMessage，供终端内嵌聊天 UI 使用 */
const threadMessageCache = new Map<string, ThreadMessage>();

function resolveStreamingAssistantId(
  items: AiThreadItem[],
  isStreaming: boolean,
): string | null {
  if (!isStreaming) return null;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (isAiThreadMessage(item) && item.role === "assistant") {
      return item.id;
    }
  }
  return null;
}

export function aiThreadToThreadMessages(
  thread: AiThreadItem[],
  options?: { isStreaming?: boolean },
): ThreadMessage[] {
  const items = normalizeAiThread(thread);
  const streamingAssistantId = resolveStreamingAssistantId(items, Boolean(options?.isStreaming));
  const messages: ThreadMessage[] = [];
  let index = 0;

  while (index < items.length) {
    const item = items[index];
    if (isAiThreadMessage(item)) {
      if (item.role === "user") {
        const signature = buildAiThreadItemSignature(item);
        const cached = threadMessageCache.get(signature);
        if (cached) {
          messages.push(cached);
          index += 1;
          continue;
        }
        const aiMsg = normalizeAiMessage({
          id: item.id,
          role: "user",
          content: item.content,
          parts: item.content ? [{ type: "text", text: item.content }] : [],
          timestamp: item.timestamp ?? Date.now(),
        });
        const threadMsg = aiMessagesToThreadMessages([aiMsg])[0];
        threadMessageCache.set(signature, threadMsg);
        messages.push(threadMsg);
        index += 1;
        continue;
      }

      const isStreamingMessage = item.id === streamingAssistantId;
      if (!isStreamingMessage) {
        const signature = buildAiThreadItemSignature(item);
        let cached = threadMessageCache.get(signature);
        if (!cached) {
          const followingTools: AiThreadToolCall[] = [];
          let scan = index + 1;
          while (scan < items.length && isAiThreadToolCall(items[scan])) {
            followingTools.push(items[scan] as AiThreadToolCall);
            scan += 1;
          }
          const aiMsg = normalizeAiMessage({
            id: item.id,
            role: "assistant",
            content: item.content,
            reasoningContent: item.reasoning?.trim() || undefined,
            parts: assistantMessageParts(item, followingTools),
            timestamp: item.timestamp ?? Date.now(),
            isStreaming: false,
            isReasoningStreaming: false,
          });
          cached = aiMessagesToThreadMessages([aiMsg])[0];
          threadMessageCache.set(signature, cached);
        }
        messages.push(cached);
        while (index + 1 < items.length && isAiThreadToolCall(items[index + 1])) {
          index += 1;
        }
        index += 1;
        continue;
      }

      const aiMessages = aiThreadToAiMessages(items.slice(index), {
        isStreaming: true,
      });
      messages.push(...aiMessagesToThreadMessages(aiMessages));
      break;
    }

    if (isAiThreadToolCall(item)) {
      const signature = buildAiThreadItemSignature(item);
      let cached = threadMessageCache.get(signature);
      if (!cached) {
        const aiMsg = normalizeAiMessage({
          id: `tool-wrap-${item.id}`,
          role: "assistant",
          content: "",
          parts: [toolCallToPart(item)],
          timestamp: Date.now(),
        });
        cached = aiMessagesToThreadMessages([aiMsg])[0];
        threadMessageCache.set(signature, cached);
      }
      messages.push(cached);
      index += 1;
      continue;
    }

    index += 1;
  }

  return messages;
}

export function invalidateAiThreadMessageCache(): void {
  threadMessageCache.clear();
}

export function messageBody(item: AiThreadMessage): string {
  const parts = [item.reasoning?.trim(), item.content.trim()].filter(Boolean);
  return parts.join("\n\n");
}

export function getAiBlockPreview(block: TerminalBlock, maxLen = 80): string {
  const thread = getResolvedAiThread(block);
  for (let i = thread.length - 1; i >= 0; i -= 1) {
    const item = thread[i];
    if (isAiThreadMessage(item) && item.role === "assistant") {
      const text = messageBody(item);
      if (text) {
        return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
      }
    }
  }
  return block.title?.trim() ?? "";
}

export function getAiBlockTextForContext(block: TerminalBlock): string {
  const thread = getResolvedAiThread(block);
  return thread
    .map((item) => {
      if (isAiThreadMessage(item)) {
        const label = item.role === "user" ? "用户" : "AI";
        return `${label}: ${messageBody(item) || item.content}`;
      }
      if (isAiThreadToolCall(item)) {
        const cmd = item.command ?? item.toolName;
        return `工具 ${cmd} [${item.status}]: ${item.result ?? ""}`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

export function aiThreadToModelMessages(
  thread: AiThreadItem[],
  options?: { excludeIds?: Set<string> },
): ModelPriorMessage[] {
  const exclude = options?.excludeIds ?? new Set<string>();
  const messages: ModelPriorMessage[] = [];

  for (const item of normalizeAiThread(thread)) {
    if (exclude.has(item.id)) continue;

    if (isAiThreadMessage(item)) {
      const body = messageBody(item);
      if (!body && item.role === "assistant") continue;
      messages.push({
        role: item.role,
        content: body || item.content,
        toolCalls: undefined,
      });
      continue;
    }

    if (isAiThreadToolCall(item)) {
      if (item.status === "pending" || item.status === "running") continue;
      messages.push({
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: item.id,
            name: item.toolName,
            arguments: item.args,
            result: undefined,
          },
        ],
      });
      messages.push({
        role: "tool",
        content: item.result ?? (item.status === "rejected" ? "用户拒绝执行" : ""),
        toolCalls: [
          {
            id: item.id,
            name: item.toolName,
            arguments: item.args,
            result: item.result,
          },
        ],
      });
    }
  }

  return messages;
}

export function pushAssistantErrorMessage(blockId: string, text: string): string {
  return useBlocksStore.getState().pushAiThreadItem(blockId, {
    kind: "message",
    role: "assistant",
    content: text,
  });
}
