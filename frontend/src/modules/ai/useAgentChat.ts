import { useCallback, useRef } from "react";
import { useAgentStore } from "./agentStore";
import { useAiModelsStore } from "../../stores/aiModelsStore";
import type { AgentMessage, AgentToolCall } from "./agentStore";

// ─── Model Factory ────────────────────────────────────────────

/**
 * Create a LangChain model instance from an AiModelConfig.
 * Supports OpenAI-compatible and Anthropic API standards.
 */
function createLangChainModel(config: {
  apiStandard: "openai" | "anthropic";
  name: string;
  baseUrl: string;
  apiKey: string;
}) {
  if (config.apiStandard === "anthropic") {
    // Dynamic import guard — if @langchain/anthropic is missing, throw clear error
    const { ChatAnthropic } = require("@langchain/anthropic") as typeof import("@langchain/anthropic");
    return new ChatAnthropic({
      model: config.name,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl || undefined,
      temperature: 0.7,
      maxTokens: 4096,
    });
  }

  // Default: OpenAI-compatible
  const { ChatOpenAI } = require("@langchain/openai") as typeof import("@langchain/openai");
  return new ChatOpenAI({
    model: config.name,
    openAIApiKey: config.apiKey,
    configuration: {
      baseURL: config.baseUrl || undefined,
    },
    temperature: 0.7,
    maxTokens: 4096,
  });
}

// ─── Hook ─────────────────────────────────────────────────────

export function useAgentChat() {
  const abortRef = useRef<AbortController | null>(null);

  const {
    addMessage,
    updateMessage,
    appendStreamContent,
    setGenerating,
    getActive,
    isGenerating,
  } = useAgentStore();

  const models = useAiModelsStore((s) => s.models);

  const sendMessage = useCallback(
    async (content: string) => {
      const conv = getActive();
      if (!conv || !content.trim() || isGenerating) return;

      // Find model config
      const modelConfig = models.find((m) => m.id === conv.modelConfigId);
      if (!modelConfig) {
        addMessage(conv.id, {
          role: "system",
          content: "⚠️ 未找到模型配置，请在设置中添加 AI 模型或在左上角选择有效模型。",
        });
        return;
      }

      // Add user message
      addMessage(conv.id, { role: "user", content: content.trim() });

      // Add placeholder assistant message for streaming
      const assistantMsgId = addMessage(conv.id, {
        role: "assistant",
        content: "",
        isStreaming: true,
      });

      setGenerating(true);
      const abortController = new AbortController();
      abortRef.current = abortController;

      try {
        // Create model instance
        const model = createLangChainModel(modelConfig);

        // Create agent with deepagents
        const { createDeepAgent } = await import("deepagents");
        const agent = createDeepAgent({
          model,
          systemPrompt:
            "你是 OmniPanel 的 AI 智能体助手，运行在用户的本地工程工作台中。" +
            "你可以帮助用户完成软件工程任务，包括代码分析、文件操作、命令执行等。" +
            "请用中文回复，除非用户使用其他语言提问。",
        });

        // Build message history for the agent
        const history = conv.messages
          .filter((m) => m.role === "user" || m.role === "assistant")
          .filter((m) => m.id !== assistantMsgId) // exclude the placeholder
          .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

        const agentMessages = [
          ...history,
          { role: "user" as const, content: content.trim() },
        ];

        // Stream the response
        const run = await agent.streamEvents(
          { messages: agentMessages },
          { version: "v3" }
        );

        // Track tool calls for display
        const toolCallsMap = new Map<string, AgentToolCall>();

        // Process the stream
        try {
          for await (const event of run) {
            if (abortController.signal.aborted) break;

            // Handle tool calls
            if (event.event === "on_tool_start") {
              const tc: AgentToolCall = {
                id: event.run_id ?? `tc_${Date.now()}`,
                name: event.name ?? "unknown",
                arguments:
                  typeof event.data?.input === "string"
                    ? event.data.input
                    : JSON.stringify(event.data?.input ?? {}),
                status: "running",
              };
              toolCallsMap.set(tc.id, tc);
              updateMessage(conv.id, assistantMsgId, {
                toolCalls: Array.from(toolCallsMap.values()),
              });
            }

            if (event.event === "on_tool_end") {
              const existing = toolCallsMap.get(event.run_id ?? "");
              if (existing) {
                existing.status = "completed";
                existing.result =
                  typeof event.data?.output === "string"
                    ? event.data.output
                    : JSON.stringify(event.data?.output ?? "");
                updateMessage(conv.id, assistantMsgId, {
                  toolCalls: Array.from(toolCallsMap.values()),
                });
              }
            }

            // Handle streaming text content
            if (event.event === "on_chat_model_stream") {
              const chunk = event.data?.chunk;
              const text =
                typeof chunk?.content === "string"
                  ? chunk.content
                  : Array.isArray(chunk?.content)
                    ? chunk.content
                        .filter(
                          (c: unknown) =>
                            typeof c === "object" &&
                            c !== null &&
                            "type" in c &&
                            (c as { type: string }).type === "text"
                        )
                        .map(
                          (c: unknown) =>
                            (c as { type: string; text: string }).text ?? ""
                        )
                        .join("")
                    : "";
              if (text) {
                appendStreamContent(conv.id, assistantMsgId, text);
              }
            }
          }
        } catch {
          // Stream iteration ended (possibly by abort)
        }

        // Mark streaming complete
        updateMessage(conv.id, assistantMsgId, { isStreaming: false });
      } catch (err: unknown) {
        const errMsg =
          err instanceof Error ? err.message : String(err);
        updateMessage(conv.id, assistantMsgId, {
          content: `❌ 请求失败: ${errMsg}`,
          isStreaming: false,
        });
      } finally {
        setGenerating(false);
        abortRef.current = null;
      }
    },
    [
      getActive,
      isGenerating,
      models,
      addMessage,
      updateMessage,
      appendStreamContent,
      setGenerating,
    ]
  );

  const stopGeneration = useCallback(() => {
    abortRef.current?.abort();
    setGenerating(false);
  }, [setGenerating]);

  return { sendMessage, stopGeneration, isGenerating };
}
