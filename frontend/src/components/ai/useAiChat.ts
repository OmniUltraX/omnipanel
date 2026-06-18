import { useCallback, useEffect, useRef, useState } from "react";

import { useAiStore } from "../../stores/aiStore";
import {
  firstModelSelectionId,
  resolveModelSelection,
  useAiModelsStore,
} from "../../stores/aiModelsStore";

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** AI 助手 LangChain 流式对话 */
export function useAiChat() {
  const conversations = useAiStore((s) => s.conversations);
  const activeConversationId = useAiStore((s) => s.activeConversationId);
  const isGenerating = useAiStore((s) => s.isGenerating);
  const currentModelSelectionId = useAiStore((s) => s.currentModelSelectionId);
  const addMessage = useAiStore((s) => s.addMessage);
  const updateMessage = useAiStore((s) => s.updateMessage);
  const appendStreamContent = useAiStore((s) => s.appendStreamContent);
  const appendStreamReasoning = useAiStore((s) => s.appendStreamReasoning);
  const createConversation = useAiStore((s) => s.createConversation);
  const setIsGenerating = useAiStore((s) => s.setIsGenerating);
  const addContext = useAiStore((s) => s.addContext);
  const removeContext = useAiStore((s) => s.removeContext);
  const draftPrompt = useAiStore((s) => s.draftPrompt);
  const clearDraftPrompt = useAiStore((s) => s.clearDraftPrompt);
  const setCurrentModelSelectionId = useAiStore((s) => s.setCurrentModelSelectionId);
  const setConnectedMcpServices = useAiStore((s) => s.setConnectedMcpServices);
  const reasoningEffort = useAiStore((s) => s.reasoningEffort);

  const providers = useAiModelsStore((s) => s.providers);

  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const activeConversation = conversations.find((c) => c.id === activeConversationId);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeConversation?.messages.length, activeConversation?.messages]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height =
        Math.min(textareaRef.current.scrollHeight, 100) + "px";
    }
  }, [input]);

  useEffect(() => {
    if (!draftPrompt) return;
    setInput(draftPrompt);
    clearDraftPrompt();
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [clearDraftPrompt, draftPrompt]);

  useEffect(() => {
    if (currentModelSelectionId) return;
    const first = firstModelSelectionId(providers);
    if (first) setCurrentModelSelectionId(first);
  }, [currentModelSelectionId, providers, setCurrentModelSelectionId]);

  const resolveSelectionId = useCallback(() => {
    if (currentModelSelectionId && resolveModelSelection(providers, currentModelSelectionId)) {
      return currentModelSelectionId;
    }
    const first = firstModelSelectionId(providers);
    if (first) setCurrentModelSelectionId(first);
    return first;
  }, [currentModelSelectionId, providers, setCurrentModelSelectionId]);

  const handleSend = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || isGenerating) return;

    let convId = activeConversationId;
    if (!convId) {
      convId = createConversation();
    }

    if (!isTauriRuntime()) {
      addMessage(convId, { role: "user", content: trimmed });
      setInput("");
      addMessage(convId, {
        role: "assistant",
        content: "AI 助手需要在 Tauri 桌面环境中运行，并先在设置中配置 AI 模型。",
      });
      return;
    }

    const selectionId = resolveSelectionId();
    const modelConfig = selectionId ? resolveModelSelection(providers, selectionId) : null;
    if (!modelConfig) {
      addMessage(convId, { role: "user", content: trimmed });
      setInput("");
      addMessage(convId, {
        role: "assistant",
        content: "请先在 **设置 → AI 模型** 中添加并启用至少一个模型。",
      });
      return;
    }

    addMessage(convId, { role: "user", content: trimmed });
    setInput("");

    const assistantMsgId = addMessage(convId, {
      role: "assistant",
      content: "",
      isStreaming: true,
      isReasoningStreaming: true,
    });

    setIsGenerating(true);
    abortRef.current?.abort();
    abortRef.current = new AbortController();

    const convState = useAiStore.getState().conversations.find((c) => c.id === convId);
    const priorMessages = (convState?.messages ?? []).slice(0, -1).slice(-20).map((m) => ({
      role: m.role,
      content: m.content,
    }));

    try {
      const { streamAgentChat } = await import("./langchain/streamAgentChat");
      const { loadAgentMcpTools } = await import("./langchain/mcpTools");
      const mcpBundle = await loadAgentMcpTools();
      setConnectedMcpServices(mcpBundle.connections);

      await streamAgentChat(
        modelConfig,
        priorMessages,
        convId,
        {
          onTextDelta: (text) => appendStreamContent(convId, assistantMsgId, text),
          onReasoningDelta: (text) => appendStreamReasoning(convId, assistantMsgId, text),
          onMcpConnections: (connections) => setConnectedMcpServices(connections),
          onToolCall: ({ id, name, arguments: args }) => {
            const conv = useAiStore.getState().conversations.find((c) => c.id === convId);
            const msg = conv?.messages.find((m) => m.id === assistantMsgId);
            const existing = msg?.toolCalls ?? [];
            updateMessage(convId, assistantMsgId, {
              toolCalls: [
                ...existing,
                { id, name, arguments: args, status: "running" as const },
              ],
            });
          },
          onToolCallUpdate: ({ id, status, result }) => {
            const conv = useAiStore.getState().conversations.find((c) => c.id === convId);
            const msg = conv?.messages.find((m) => m.id === assistantMsgId);
            if (!msg?.toolCalls) return;
            updateMessage(convId, assistantMsgId, {
              toolCalls: msg.toolCalls.map((tc) =>
                tc.id === id ? { ...tc, status, result: result ?? tc.result } : tc,
              ),
            });
          },
          onError: (message) => {
            appendStreamContent(convId, assistantMsgId, `\n\n错误：${message}`);
            updateMessage(convId, assistantMsgId, { isStreaming: false });
          },
          onDone: () => {
            updateMessage(convId, assistantMsgId, {
              isStreaming: false,
              isReasoningStreaming: false,
            });
          },
        },
        abortRef.current.signal,
        { reasoningEffort, mcpBundle },
      );
    } catch (err) {
      appendStreamContent(
        convId,
        assistantMsgId,
        `\n\n发送失败：${err instanceof Error ? err.message : String(err)}`,
      );
      updateMessage(convId, assistantMsgId, { isStreaming: false });
    } finally {
      setIsGenerating(false);
      abortRef.current = null;
    }
  }, [
    input,
    isGenerating,
    activeConversationId,
    createConversation,
    addMessage,
    appendStreamContent,
    appendStreamReasoning,
    updateMessage,
    setIsGenerating,
    providers,
    resolveSelectionId,
    reasoningEffort,
    setConnectedMcpServices,
  ]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  return {
    input,
    setInput,
    messagesEndRef,
    textareaRef,
    activeConversation,
    activeConversationId,
    isGenerating,
    handleSend,
    handleKeyDown,
    addContext,
    removeContext,
  };
}
