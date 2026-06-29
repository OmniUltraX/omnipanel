import type {
  ThreadAssistantMessage,
  ThreadMessage,
  ThreadUserMessage,
} from "@assistant-ui/react";

export type DebugMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoningContent?: string;
  timestamp: number;
  toolCalls?: {
    id: string;
    name: string;
    arguments: string;
    result?: string;
    status: "running" | "completed" | "failed";
  }[];
  isStreaming?: boolean;
};

function safeParseJson(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function debugMessageToThreadMessage(msg: DebugMessage): ThreadMessage {
  if (msg.role === "user") {
    return {
      id: msg.id,
      role: "user",
      createdAt: new Date(msg.timestamp),
      content: [{ type: "text", text: msg.content }],
      attachments: [],
      metadata: { custom: {} },
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
  for (const tc of msg.toolCalls ?? []) {
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

export function debugMessagesToThreadMessages(messages: readonly DebugMessage[]): ThreadMessage[] {
  return messages.map(debugMessageToThreadMessage);
}

export function extractUserText(message: ThreadMessage): string {
  for (const part of message.content) {
    if (part.type === "text") return part.text;
  }
  return "";
}
