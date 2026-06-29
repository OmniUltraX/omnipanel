import type {
  ThreadAssistantMessage,
  ThreadMessage,
  ThreadUserMessage,
} from "@assistant-ui/react";

import type { AiMessage, ToolCallState } from "../../../stores/aiStore";

function extractThreadText(message: ThreadMessage): string {
  for (const part of message.content) {
    if (part.type === "text") {
      return part.text;
    }
  }
  return "";
}

function extractThreadReasoning(message: ThreadAssistantMessage): string {
  let text = "";
  for (const part of message.content) {
    if (part.type === "reasoning") {
      text += (part as { type: "reasoning"; text: string }).text;
    }
  }
  return text;
}

function extractThreadToolCalls(message: ThreadAssistantMessage): ToolCallState[] {
  const toolCalls: ToolCallState[] = [];
  for (const part of message.content) {
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
    toolCalls.push({
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
  return toolCalls;
}

export function aiMessageToThreadMessage(msg: AiMessage): ThreadMessage {
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

  const parts: ThreadAssistantMessage["content"][number][] = [];
  if (msg.reasoningContent) {
    parts.push({
      type: "reasoning",
      text: msg.reasoningContent,
    } as ThreadAssistantMessage["content"][number]);
  }
  if (msg.content) {
    parts.push({ type: "text", text: msg.content } as ThreadAssistantMessage["content"][number]);
  }
  if (msg.toolCalls?.length) {
    for (const tc of msg.toolCalls) {
      parts.push({
        type: "tool-call",
        toolCallId: tc.id,
        toolName: tc.name,
        args: safeParseJson(tc.arguments),
        argsText: tc.arguments,
        ...(tc.result !== undefined
          ? { result: tc.result, isError: tc.status === "failed" }
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
    return {
      id: msg.id,
      role: "user",
      content: extractThreadText(msg),
      timestamp: msg.createdAt?.getTime() ?? Date.now(),
    };
  }

  if (msg.role === "assistant") {
    const toolCalls = extractThreadToolCalls(msg);
    return {
      id: msg.id,
      role: "assistant",
      content: extractThreadText(msg),
      reasoningContent: extractThreadReasoning(msg) || undefined,
      timestamp: msg.createdAt?.getTime() ?? Date.now(),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      isStreaming: msg.status?.type === "running",
      isReasoningStreaming:
        msg.status?.type === "running" && !extractThreadText(msg).trim(),
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
  return messages
    .filter((msg) => msg.role === "user" || msg.role === "assistant")
    .map(aiMessageToThreadMessage);
}

function safeParseJson(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}
