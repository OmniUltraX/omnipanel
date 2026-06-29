import {
  methods,
  type AgentContext,
  type ContentBlock,
  type SessionId,
  type ToolCallId,
} from "@agentclientprotocol/sdk";

import type { AgentStreamEvent } from "../../core/index.js";

function log(...args: unknown[]): void {
  console.error("[omniagent:acp]", ...args);
}

export function promptBlocksToText(blocks: ContentBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === "text") {
        return block.text;
      }
      if (block.type === "resource_link") {
        return `[资源链接 ${block.name ?? block.uri}]`;
      }
      if (block.type === "resource") {
        return `[内嵌资源 ${block.resource.uri ?? ""}]`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

async function notifyAgentChunk(
  client: AgentContext,
  sessionId: SessionId,
  text: string,
  messageId: string,
): Promise<void> {
  if (!text) return;
  await client.notify(methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
      messageId,
    },
  });
}

async function notifyThoughtChunk(
  client: AgentContext,
  sessionId: SessionId,
  text: string,
  messageId: string,
): Promise<void> {
  if (!text) return;
  await client.notify(methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text },
      messageId,
    },
  });
}

async function notifyToolCall(
  client: AgentContext,
  sessionId: SessionId,
  toolCallId: ToolCallId,
  title: string,
  rawInput: unknown,
): Promise<void> {
  await client.notify(methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: "tool_call",
      toolCallId,
      title,
      kind: "other",
      status: "in_progress",
      rawInput,
    },
  });
}

async function notifyToolResult(
  client: AgentContext,
  sessionId: SessionId,
  toolCallId: ToolCallId,
  title: string,
  rawOutput: unknown,
  failed: boolean,
): Promise<void> {
  await client.notify(methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId,
      title,
      status: failed ? "failed" : "completed",
      rawOutput,
    },
  });
}

async function requestToolPermission(
  client: AgentContext,
  sessionId: SessionId,
  toolCallId: ToolCallId,
  title: string,
  rawInput: unknown,
): Promise<boolean> {
  try {
    const response = await client.request(methods.client.session.requestPermission, {
      sessionId,
      toolCall: {
        toolCallId,
        title,
        status: "pending",
        rawInput,
      },
      options: [
        { optionId: "allow_once", name: "允许一次", kind: "allow_once" },
        { optionId: "reject_once", name: "拒绝", kind: "reject_once" },
      ],
    });

    if (response.outcome.outcome === "cancelled") {
      return false;
    }
    return response.outcome.optionId === "allow_once" || response.outcome.optionId === "allow_always";
  } catch (error) {
    log("权限请求失败，默认拒绝:", error);
    return false;
  }
}

/** 将核心层 AgentStreamEvent 转为 ACP session/update 通知。 */
export function createAcpEventSink(
  client: AgentContext,
  sessionId: SessionId,
  messageId: string,
): (event: AgentStreamEvent) => Promise<void> {
  const toolTitles = new Map<string, string>();

  return async (event) => {
    switch (event.type) {
      case "content_delta":
        await notifyAgentChunk(client, sessionId, event.text, messageId);
        break;
      case "reasoning_delta":
        await notifyThoughtChunk(client, sessionId, event.text, messageId);
        break;
      case "tool_call": {
        toolTitles.set(event.id, event.name);
        let rawInput: unknown = {};
        try {
          rawInput = JSON.parse(event.arguments || "{}");
        } catch {
          rawInput = event.arguments;
        }
        await notifyToolCall(client, sessionId, event.id, event.name, rawInput);
        void requestToolPermission(client, sessionId, event.id, event.name, rawInput);
        break;
      }
      case "tool_call_update":
        await notifyToolResult(
          client,
          sessionId,
          event.id,
          toolTitles.get(event.id) ?? "tool",
          event.result,
          event.status === "failed",
        );
        break;
    }
  };
}

export async function notifyAcpErrorChunk(
  client: AgentContext,
  sessionId: SessionId,
  message: string,
  messageId: string,
): Promise<void> {
  await notifyAgentChunk(client, sessionId, `\n\n错误: ${message}`, messageId);
}
