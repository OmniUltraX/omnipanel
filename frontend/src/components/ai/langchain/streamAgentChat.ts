import { AIMessage, HumanMessage } from "@langchain/core/messages";

import type { ReasoningEffortLevel } from "../../../stores/aiStore";
import type { AgentMcpToolsBundle } from "./mcpTools";
import { loadAgentMcpTools } from "./mcpTools";
import type { OmniModelConfig } from "./createOmniAgent";
import { getOmniAgent } from "./createOmniAgent";

export interface StreamChatOptions {
  reasoningEffort?: ReasoningEffortLevel;
  mcpBundle?: AgentMcpToolsBundle;
}

export interface ChatHistoryMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
}

export interface AgentStreamCallbacks {
  onTextDelta: (text: string) => void;
  onReasoningDelta?: (text: string) => void;
  onToolCall?: (payload: { id: string; name: string; arguments: string }) => void;
  onToolCallUpdate?: (payload: {
    id: string;
    status: "completed" | "failed";
    result?: string;
  }) => void;
  onMcpConnections?: (connections: AgentMcpToolsBundle["connections"]) => void;
  onError: (message: string) => void;
  onDone: () => void;
}

function toLangChainMessages(messages: ChatHistoryMessage[]) {
  return messages
    .filter((m) => (m.role === "user" || m.role === "assistant") && m.content.trim())
    .map((m) => (m.role === "user" ? new HumanMessage(m.content) : new AIMessage(m.content)));
}

function formatToolOutput(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

/**
 * LangChain 智能体流式对话（ReAct + MCP 工具）。
 */
export async function streamAgentChat(
  modelConfig: OmniModelConfig,
  history: ChatHistoryMessage[],
  _threadId: string,
  callbacks: AgentStreamCallbacks,
  signal?: AbortSignal,
  streamOptions?: StreamChatOptions,
): Promise<void> {
  try {
    const bundle = streamOptions?.mcpBundle ?? (await loadAgentMcpTools());
    callbacks.onMcpConnections?.(bundle.connections);

    const agent = await getOmniAgent(modelConfig, bundle.tools, bundle.cacheKey);
    const run = await agent.streamEvents(
      { messages: toLangChainMessages(history) },
      { version: "v3", signal, recursionLimit: 25 },
    );

    const consumeMessages = async () => {
      for await (const msg of run.messages) {
        if (signal?.aborted) break;

        if ("text" in msg && msg.text) {
          for await (const token of msg.text) {
            if (signal?.aborted) break;
            if (token) callbacks.onTextDelta(token);
          }
        }

        if ("reasoning" in msg && msg.reasoning) {
          for await (const token of msg.reasoning) {
            if (signal?.aborted) break;
            if (token) callbacks.onReasoningDelta?.(token);
          }
        }
      }
    };

    const consumeToolCalls = async () => {
      for await (const call of run.toolCalls) {
        if (signal?.aborted) break;

        const callId = `tool_${call.name}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        callbacks.onToolCall?.({
          id: callId,
          name: call.name,
          arguments: JSON.stringify(call.input ?? {}),
        });

        try {
          const output = await call.output;
          callbacks.onToolCallUpdate?.({
            id: callId,
            status: "completed",
            result: formatToolOutput(output),
          });
        } catch (err) {
          callbacks.onToolCallUpdate?.({
            id: callId,
            status: "failed",
            result: err instanceof Error ? err.message : String(err),
          });
        }
      }
    };

    await Promise.all([consumeMessages(), consumeToolCalls(), run.output]);
    callbacks.onDone();
  } catch (err) {
    if (signal?.aborted) {
      callbacks.onDone();
      return;
    }
    callbacks.onError(err instanceof Error ? err.message : String(err));
  }
}
