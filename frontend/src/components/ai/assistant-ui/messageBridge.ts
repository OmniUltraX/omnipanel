import type {
  ThreadAssistantMessage,
  ThreadMessage,
  ThreadUserMessage,
} from "@assistant-ui/react";

import {
  deriveCompatFields,
  normalizeAiMessage,
  partsFromFlatFields,
  type AiMessage,
  type AiMessagePart,
  type ToolCallState,
} from "../../../stores/aiStore";

const completedThreadMessageCache = new Map<string, ThreadMessage>();

function aiMessageCacheKey(msg: AiMessage): string {
  const parts = partsFromFlatFields(msg);
  const partSig = parts
    .map((p) => {
      if (p.type === "text" || p.type === "reasoning") {
        return `${p.type}:${p.text.length}`;
      }
      return `tool:${p.id}:${p.status}:${p.result?.length ?? 0}:${p.arguments.length}`;
    })
    .join("|");
  return `${msg.id}:${msg.role}:${partSig}:s=${msg.isStreaming ? 1 : 0}`;
}

function extractThreadParts(message: ThreadAssistantMessage): AiMessagePart[] {
  const parts: AiMessagePart[] = [];
  for (const part of message.content) {
    if (part.type === "text") {
      const text = (part as { type: "text"; text: string }).text;
      if (text) parts.push({ type: "text", text });
      continue;
    }
    if (part.type === "reasoning") {
      const text = (part as { type: "reasoning"; text: string }).text;
      if (text) parts.push({ type: "reasoning", text });
      continue;
    }
    if (part.type !== "tool-call") continue;
    const tc = part as {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      args?: Record<string, unknown>;
      argsText?: string;
      result?: unknown;
      isError?: boolean;
    };
    parts.push({
      type: "tool-call",
      id: tc.toolCallId,
      name: tc.toolName,
      arguments: tc.argsText ?? JSON.stringify(tc.args ?? {}),
      result: typeof tc.result === "string" ? tc.result : undefined,
      status:
        tc.isError === true
          ? "failed"
          : tc.result !== undefined
            ? "completed"
            : "running",
    });
  }
  return parts;
}

export function aiMessageToThreadMessage(msg: AiMessage): ThreadMessage {
  const normalized = normalizeAiMessage(msg);
  if (!normalized.isStreaming) {
    const cacheKey = aiMessageCacheKey(normalized);
    const cached = completedThreadMessageCache.get(cacheKey);
    if (cached) return cached;
    const built = buildAiMessageToThreadMessage(normalized);
    completedThreadMessageCache.set(cacheKey, built);
    return built;
  }
  return buildAiMessageToThreadMessage(normalized);
}

function buildAiMessageToThreadMessage(msg: AiMessage): ThreadMessage {
  if (msg.role === "user") {
    return {
      id: msg.id,
      role: "user",
      createdAt: new Date(msg.timestamp),
      content: [{ type: "text", text: msg.content }],
      attachments: [],
      metadata: {
        custom: {},
      },
    } satisfies ThreadUserMessage;
  }

  const ordered = partsFromFlatFields(msg);
  const parts: ThreadAssistantMessage["content"][number][] = [];
  for (const part of ordered) {
    if (part.type === "reasoning") {
      parts.push({
        type: "reasoning",
        text: part.text,
      } as ThreadAssistantMessage["content"][number]);
    } else if (part.type === "text") {
      parts.push({
        type: "text",
        text: part.text,
      } as ThreadAssistantMessage["content"][number]);
    } else if (part.type === "tool-call") {
      const toolCallId =
        part.id === msg.id ? `${msg.id}::tool::${part.id}` : part.id;
      parts.push({
        type: "tool-call",
        toolCallId,
        toolName: part.name,
        args: safeParseJson(part.arguments),
        argsText: part.arguments,
        ...(part.result !== undefined
          ? { result: part.result, isError: part.status === "failed" }
          : {}),
      } as unknown as ThreadAssistantMessage["content"][number]);
    }
  }

  return {
    id: msg.id,
    role: "assistant",
    createdAt: new Date(msg.timestamp),
    status: msg.isStreaming ? { type: "running" } : { type: "complete", reason: "stop" },
    content: parts,
    metadata: {
      custom: {},
      unstable_state: null,
      unstable_annotations: [],
      unstable_data: [],
      steps: [],
    },
  } satisfies ThreadAssistantMessage;
}

export function threadMessageToAiMessage(msg: ThreadMessage): AiMessage | null {
  if (msg.role === "user") {
    const content =
      msg.content.find((p) => p.type === "text")?.text ??
      "";
    return normalizeAiMessage({
      id: msg.id,
      role: "user",
      content,
      parts: content ? [{ type: "text", text: content }] : [],
      timestamp: msg.createdAt?.getTime() ?? Date.now(),
    });
  }

  if (msg.role === "assistant") {
    const parts = extractThreadParts(msg);
    const compat = deriveCompatFields(parts);
    return {
      id: msg.id,
      role: "assistant",
      parts,
      ...compat,
      timestamp: msg.createdAt?.getTime() ?? Date.now(),
      isStreaming: msg.status?.type === "running",
      isReasoningStreaming:
        msg.status?.type === "running" && !compat.content.trim(),
    };
  }

  return null;
}

export function threadMessagesToAiMessages(messages: readonly ThreadMessage[]): AiMessage[] {
  const result: AiMessage[] = [];
  for (const message of messages) {
    const converted = threadMessageToAiMessage(message);
    if (converted) {
      result.push(converted);
    }
  }
  return result;
}

export function aiMessagesToThreadMessages(messages: readonly AiMessage[]): ThreadMessage[] {
  const seenMessageIds = new Set<string>();
  const seenToolCallIds = new Set<string>();

  return messages
    .filter((msg) => msg.role === "user" || msg.role === "assistant")
    .map((msg, index) => {
      let messageId = msg.id;
      if (seenMessageIds.has(messageId)) {
        messageId = `${messageId}__${index}`;
      }
      seenMessageIds.add(messageId);

      const normalized = normalizeAiMessage({ ...msg, id: messageId });
      const threadMsg = aiMessageToThreadMessage(normalized);
      if (threadMsg.role !== "assistant") {
        return threadMsg;
      }

      const hasTools = partsFromFlatFields(normalized).some((p) => p.type === "tool-call");
      if (!hasTools) {
        return threadMsg;
      }

      const content = threadMsg.content.map((part) => {
        if (part.type !== "tool-call") return part;
        const tc = part as { type: "tool-call"; toolCallId: string };
        let toolCallId = tc.toolCallId;
        if (seenMessageIds.has(toolCallId) || seenToolCallIds.has(toolCallId)) {
          toolCallId = `${messageId}::tool::${toolCallId}`;
        }
        seenToolCallIds.add(toolCallId);
        return { ...part, toolCallId } as typeof part;
      });

      return { ...threadMsg, content };
    });
}

function safeParseJson(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 供测试 / 调试：从 ThreadMessage 抽出 tool 列表 */
export function extractToolCallsFromThread(message: ThreadAssistantMessage): ToolCallState[] {
  return extractThreadParts(message).flatMap((p) =>
    p.type === "tool-call"
      ? [
          {
            id: p.id,
            name: p.name,
            arguments: p.arguments,
            result: p.result,
            status: p.status,
          },
        ]
      : [],
  );
}
