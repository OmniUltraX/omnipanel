import { randomUUID } from "node:crypto";
import { AIMessage, AIMessageChunk, HumanMessage, type BaseMessage } from "@langchain/core/messages";

import { extractStreamChunkParts } from "./streamChunks.js";
import type { AgentStreamEvent, AgentTurnContext, AgentTurnHandlers } from "./types.js";

type ToolCallTracker = {
  toolCallId: string;
  title: string;
};

function serializeToolInput(rawInput: unknown): string {
  if (typeof rawInput === "string") return rawInput;
  try {
    return JSON.stringify(rawInput ?? {});
  } catch {
    return "{}";
  }
}

function serializeToolOutput(rawOutput: unknown): string | undefined {
  if (rawOutput === undefined || rawOutput === null) return undefined;
  if (typeof rawOutput === "string") return rawOutput;
  try {
    return JSON.stringify(rawOutput);
  } catch {
    return String(rawOutput);
  }
}

/** 执行一轮 DeepAgent 对话，流式回调文本与工具事件。 */
export async function runAgentTurn(
  ctx: AgentTurnContext,
  userText: string,
  handlers: AgentTurnHandlers,
): Promise<BaseMessage[]> {
  ctx.messages.push(new HumanMessage(userText));
  const pendingTools = new Map<string, ToolCallTracker>();
  let assistantReply = "";

  const stream = ctx.graph.streamEvents(
    { messages: ctx.messages },
    {
      version: "v2",
      configurable: { thread_id: ctx.sessionId },
    },
  );

  for await (const event of stream) {
    if (handlers.signal.aborted) {
      throw new DOMException("Prompt cancelled", "AbortError");
    }

    if (event.event === "on_chat_model_stream") {
      const chunk = event.data?.chunk;
      if (chunk instanceof AIMessageChunk) {
        const { text, reasoning } = extractStreamChunkParts(chunk);
        if (reasoning) {
          await handlers.onEvent({ type: "reasoning_delta", text: reasoning });
        }
        if (text) {
          assistantReply += text;
          await handlers.onEvent({ type: "content_delta", text });
        }
      }
      continue;
    }

    if (event.event === "on_tool_start") {
      const toolCallId = randomUUID();
      const title = event.name ?? "tool";
      const rawInput = event.data?.input ?? {};
      const runId = typeof event.run_id === "string" ? event.run_id : randomUUID();
      pendingTools.set(runId, { toolCallId, title });

      await handlers.onEvent({
        type: "tool_call",
        id: toolCallId,
        name: title,
        arguments: serializeToolInput(rawInput),
      });
      continue;
    }

    if (event.event === "on_tool_end") {
      const runId = typeof event.run_id === "string" ? event.run_id : "";
      const tracked = runId ? pendingTools.get(runId) : undefined;
      if (runId) pendingTools.delete(runId);

      const toolCallId = tracked?.toolCallId ?? randomUUID();
      const rawOutput = event.data?.output;
      const failed = Boolean(event.data?.error);
      await handlers.onEvent({
        type: "tool_call_update",
        id: toolCallId,
        status: failed ? "failed" : "completed",
        result: serializeToolOutput(rawOutput),
      });
    }
  }

  try {
    const state = (await ctx.graph.getState({
      configurable: { thread_id: ctx.sessionId },
    })) as { values?: { messages?: BaseMessage[] } };
    if (state.values?.messages) {
      ctx.messages = state.values.messages;
      return ctx.messages;
    }
  } catch {
    /* 回退到流式累积结果 */
  }

  if (assistantReply.trim()) {
    ctx.messages.push(new AIMessage(assistantReply));
  }

  return ctx.messages;
}

export type { AgentStreamEvent, AgentTurnContext, AgentTurnHandlers };
