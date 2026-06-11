import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";

import type { ReasoningEffortLevel } from "../../../stores/aiStore";
import type { OmniModelConfig } from "./createOmniAgent";
import { getOmniChatModel, OMNI_SYSTEM_PROMPT } from "./createOmniAgent";

export interface StreamChatOptions {
  reasoningEffort?: ReasoningEffortLevel;
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
  onError: (message: string) => void;
  onDone: () => void;
}

function toLangChainMessages(messages: ChatHistoryMessage[]) {
  return messages
    .filter((m) => (m.role === "user" || m.role === "assistant") && m.content.trim())
    .map((m) => (m.role === "user" ? new HumanMessage(m.content) : new AIMessage(m.content)));
}

function extractReasoningDelta(chunk: unknown): string {
  if (!chunk || typeof chunk !== "object") return "";
  const kwargs = (chunk as { additional_kwargs?: Record<string, unknown> }).additional_kwargs;
  const reasoning = kwargs?.reasoning_content;
  return typeof reasoning === "string" ? reasoning : "";
}

function extractTextDelta(chunk: unknown): string {
  if (!chunk || typeof chunk !== "object") return "";
  const content = (chunk as { content?: unknown }).content;
  return typeof content === "string" ? content : "";
}

function buildStreamCallOptions(
  modelConfig: OmniModelConfig,
  signal: AbortSignal | undefined,
  streamOptions?: StreamChatOptions,
) {
  const callOptions: Record<string, unknown> = { signal };
  const effort = streamOptions?.reasoningEffort;
  if (!effort || effort === "default") return callOptions;

  if (modelConfig.apiStandard === "openai") {
    // o 系列走 reasoningEffort；DeepSeek 等 OpenAI 兼容端点走 modelKwargs
    callOptions.reasoningEffort = effort;
    callOptions.modelKwargs = { reasoning_effort: effort };
  }

  return callOptions;
}

/**
 * LangChain 流式对话。
 * 直连 ChatModel.stream()，从 chunk.additional_kwargs.reasoning_content 提取思考内容
 *（OpenAI 兼容推理模型如 DeepSeek 的 delta.reasoning_content）。
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
    const model = await getOmniChatModel(modelConfig);
    const messages = [new SystemMessage(OMNI_SYSTEM_PROMPT), ...toLangChainMessages(history)];
    const stream = await model.stream(
      messages,
      buildStreamCallOptions(modelConfig, signal, streamOptions),
    );

    for await (const chunk of stream) {
      if (signal?.aborted) break;

      const text = extractTextDelta(chunk);
      if (text) callbacks.onTextDelta(text);

      const reasoning = extractReasoningDelta(chunk);
      if (reasoning) callbacks.onReasoningDelta?.(reasoning);
    }

    callbacks.onDone();
  } catch (err) {
    if (signal?.aborted) {
      callbacks.onDone();
      return;
    }
    callbacks.onError(err instanceof Error ? err.message : String(err));
  }
}
