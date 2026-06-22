import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import type {
  AppendMessage,
  ExternalStoreAdapter,
  ThreadMessage,
} from "@assistant-ui/react";
import { useExternalStoreRuntime } from "@assistant-ui/react";

import { commands } from "../../../ipc/bindings";
import {
  firstModelSelectionId,
  resolveModelSelection,
  useAiModelsStore,
} from "../../../stores/aiModelsStore";
import { useAiStore } from "../../../stores/aiStore";
import { getModuleAiContextText, getModuleMcpTools, executeModuleMcpTool } from "../../../lib/ai/context";
import type { ModuleKey } from "../../../lib/paths";
import { moduleKeyFromPath } from "../../../lib/workspaceModuleRoutes";

import {
  buildModelMessages,
  mergeToolCallDeltas,
  streamModelChat,
  type AiToolDef,
  type ModelConfig,
} from "./chatModel";
import {
  aiMessagesToThreadMessages,
  threadMessagesToAiMessages,
} from "./messageBridge";

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function extractUserContent(threadMessage: ThreadMessage): string {
  for (const part of threadMessage.content) {
    if (part.type === "text") return part.text;
  }
  return "";
}

async function loadExternalMcpToolDefs(): Promise<AiToolDef[]> {
  if (!isTauriRuntime()) return [];
  const listResult = await commands.mcpListServices();
  if (listResult.status !== "ok") return [];

  const running = listResult.data.filter((s) => s.status === "running");
  const defs: AiToolDef[] = [];

  for (const service of running) {
    const toolsResult = await commands.mcpListServiceTools(service.id);
    if (toolsResult.status !== "ok") continue;
    for (const tool of toolsResult.data) {
      defs.push({
        serviceId: service.id,
        originalName: tool.name,
        description: tool.description ?? tool.name,
        kind: "external",
      });
    }
  }

  return defs;
}

function loadModuleToolDefs(moduleKey: ModuleKey | null): AiToolDef[] {
  if (!moduleKey) return [];
  return getModuleMcpTools(moduleKey).map((tool) => ({
    serviceId: `module:${moduleKey}`,
    originalName: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    kind: "module" as const,
    moduleKey,
  }));
}

async function loadAiToolDefs(moduleKey: ModuleKey | null): Promise<AiToolDef[]> {
  const [moduleTools, externalTools] = await Promise.all([
    Promise.resolve(loadModuleToolDefs(moduleKey)),
    loadExternalMcpToolDefs(),
  ]);
  return [...moduleTools, ...externalTools];
}

async function executeToolCall(
  toolDef: AiToolDef,
  args: string,
): Promise<{ result: string; success: boolean }> {
  if (toolDef.kind === "module" && toolDef.moduleKey) {
    return executeModuleMcpTool(toolDef.moduleKey, toolDef.originalName, args);
  }
  return executeMcpTool(toolDef.serviceId, toolDef.originalName, args);
}

async function executeMcpTool(
  serviceId: string,
  toolName: string,
  args: string,
): Promise<{ result: string; success: boolean }> {
  const result = await commands.mcpCallTool(serviceId, toolName, args);
  if (result.status !== "ok") {
    return { result: result.error ?? "MCP tool call failed", success: false };
  }
  if (result.data.isError) {
    return { result: result.data.content || "MCP tool returned error", success: false };
  }
  return { result: result.data.content, success: true };
}

const EMPTY_MESSAGE_LIST: ThreadMessage[] = [];

export function AiRuntimeProvider({ children }: { children: ReactNode }) {
  const conversations = useAiStore((s) => s.conversations);
  const activeConversationId = useAiStore((s) => s.activeConversationId);
  const isGenerating = useAiStore((s) => s.isGenerating);
  const currentModelSelectionId = useAiStore((s) => s.currentModelSelectionId);
  const reasoningEffort = useAiStore((s) => s.reasoningEffort);
  const addMessage = useAiStore((s) => s.addMessage);
  const updateMessage = useAiStore((s) => s.updateMessage);
  const appendStreamContent = useAiStore((s) => s.appendStreamContent);
  const appendStreamReasoning = useAiStore((s) => s.appendStreamReasoning);
  const setIsGenerating = useAiStore((s) => s.setIsGenerating);
  const setConnectedMcpServices = useAiStore((s) => s.setConnectedMcpServices);
  const setCurrentModelSelectionId = useAiStore((s) => s.setCurrentModelSelectionId);
  const createConversation = useAiStore((s) => s.createConversation);
  const replaceConversationMessages = useAiStore((s) => s.replaceConversationMessages);

  const providers = useAiModelsStore((s) => s.providers);

  const abortRef = useRef<AbortController | null>(null);

  const activeConversation = conversations.find((c) => c.id === activeConversationId);

  const [threadMessages, setThreadMessages] = useState<ThreadMessage[]>([]);
  const threadMessagesRef = useRef<ThreadMessage[]>([]);
  threadMessagesRef.current = threadMessages;

  useEffect(() => {
    if (currentModelSelectionId) return;
    const first = firstModelSelectionId(providers);
    if (first) setCurrentModelSelectionId(first);
  }, [currentModelSelectionId, providers, setCurrentModelSelectionId]);

  useEffect(() => {
    if (!activeConversation) {
      setThreadMessages([]);
      return;
    }
    setThreadMessages(aiMessagesToThreadMessages(activeConversation.messages));
  }, [activeConversation]);

  const getModelConfig = useCallback((): ModelConfig | null => {
    const selectionId = currentModelSelectionId;
    if (!selectionId) {
      const first = firstModelSelectionId(providers);
      if (!first) return null;
      setCurrentModelSelectionId(first);
      const resolved = resolveModelSelection(providers, first);
      if (!resolved) return null;
      return resolved;
    }
    const resolved = resolveModelSelection(providers, selectionId);
    if (!resolved) return null;
    return resolved;
  }, [currentModelSelectionId, providers, setCurrentModelSelectionId]);

  const getPriorMessages = useCallback(
    (convId: string) => {
      const conv = useAiStore.getState().conversations.find((c) => c.id === convId);
      if (!conv) return [];
      return conv.messages.slice(-20).map((m) => ({
        role: m.role,
        content: m.content,
        toolCalls: m.toolCalls?.map((tc) => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
          result: tc.result,
        })),
      }));
    },
    [],
  );

  const handleSetMessages = useCallback(
    (messages: readonly ThreadMessage[]) => {
      const next = [...messages];
      setThreadMessages(next);
      const convId = activeConversationId;
      if (!convId) return;
      replaceConversationMessages(convId, threadMessagesToAiMessages(next));
    },
    [activeConversationId, replaceConversationMessages],
  );

  const runGenerationRef =
    useRef<
      (
        convId: string,
        assistantMsgId: string,
        priorMessages: ReturnType<typeof getPriorMessages>,
        modelConfig: ModelConfig,
      ) => Promise<void>
    >();

  runGenerationRef.current = async (
    convId,
    assistantMsgId,
    priorMessages,
    modelConfig,
  ) => {
    setIsGenerating(true);
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    const signal = abortRef.current.signal;

    const moduleKey =
      typeof window !== "undefined"
        ? moduleKeyFromPath(window.location.pathname)
        : null;

    const toolDefs = await loadAiToolDefs(moduleKey);
    setConnectedMcpServices(
      toolDefs.map((t) => ({
        serviceId: t.serviceId,
        serviceName: t.kind === "module" ? `模块:${t.moduleKey}` : t.serviceId,
        builtin: t.kind === "module",
        toolCount: 1,
      })),
    );

    try {
      const toolCallAcc = new Map<number, { id?: string; name?: string; args: string }>();
      const moduleContextText = moduleKey
        ? getModuleAiContextText(moduleKey)
        : null;

      while (true) {
        toolCallAcc.clear();

        const { apiMessages } = buildModelMessages(priorMessages, toolDefs, {
          moduleContextText,
        });

        const stream = streamModelChat(apiMessages, modelConfig, toolDefs, {
          signal,
          reasoningEffort:
            reasoningEffort !== "default" ? reasoningEffort : undefined,
        });

        for await (const chunk of stream) {
          if (signal.aborted) break;

          if (chunk.type === "text") {
            appendStreamContent(convId, assistantMsgId, chunk.delta);
          }

          if (chunk.type === "reasoning") {
            appendStreamReasoning(convId, assistantMsgId, chunk.delta);
          }

          if (chunk.type === "tool-call-delta") {
            mergeToolCallDeltas(toolCallAcc, [chunk]);
          }
        }

        if (signal.aborted) break;

        const resolvedCalls = mergeToolCallDeltas(toolCallAcc, []);
        if (resolvedCalls.length === 0) break;

        for (const tc of resolvedCalls) {
          const currentConv = useAiStore
            .getState()
            .conversations.find((c) => c.id === convId);
          const currentMsg = currentConv?.messages.find(
            (m) => m.id === assistantMsgId,
          );
          const existing = currentMsg?.toolCalls ?? [];

          if (!existing.some((e) => e.id === tc.id)) {
            appendStreamContent(convId, assistantMsgId, "");
            updateMessage(convId, assistantMsgId, {
              toolCalls: [
                ...existing,
                {
                  id: tc.id,
                  name: tc.name,
                  arguments: tc.args,
                  status: "running",
                },
              ],
            });
          }
        }

        for (const tc of resolvedCalls) {
          const toolDef = toolDefs.find(
            (t) =>
              t.originalName === tc.name ||
              `${t.serviceId}/${t.originalName}` === tc.name ||
              tc.name.includes(t.originalName),
          );

          if (!toolDef) {
            appendStreamContent(
              convId,
              assistantMsgId,
              `\n\n*Unknown tool: ${tc.name}*`,
            );
            updateMessage(convId, assistantMsgId, {
              toolCalls: useAiStore
                .getState()
                .conversations.find((c) => c.id === convId)
                ?.messages.find((m) => m.id === assistantMsgId)
                ?.toolCalls?.map((t) =>
                  t.id === tc.id
                    ? { ...t, status: "failed", result: "Tool not found" }
                    : t,
                ),
            });
            continue;
          }

          const { result, success } = await executeToolCall(toolDef, tc.args);

          updateMessage(convId, assistantMsgId, {
            toolCalls: useAiStore
              .getState()
              .conversations.find((c) => c.id === convId)
              ?.messages.find((m) => m.id === assistantMsgId)
              ?.toolCalls?.map((t) =>
                t.id === tc.id
                  ? { ...t, status: success ? "completed" : "failed", result }
                  : t,
              ),
          });

          priorMessages.push({
            role: "assistant",
            content: "",
            toolCalls: [{ id: tc.id, name: tc.name, arguments: tc.args }],
          });
          priorMessages.push({
            role: "tool",
            content: result,
            toolCalls: [{ id: tc.id, name: tc.name, arguments: tc.args }],
          });
        }
      }

      updateMessage(convId, assistantMsgId, {
        isStreaming: false,
        isReasoningStreaming: false,
      });
    } catch (err) {
      if (signal.aborted) {
        updateMessage(convId, assistantMsgId, {
          isStreaming: false,
          isReasoningStreaming: false,
        });
      } else {
        appendStreamContent(
          convId,
          assistantMsgId,
          `\n\nError: ${err instanceof Error ? err.message : String(err)}`,
        );
        updateMessage(convId, assistantMsgId, {
          isStreaming: false,
          isReasoningStreaming: false,
        });
      }
    } finally {
      setIsGenerating(false);
      abortRef.current = null;
    }
  };

  const onNewRef = useRef<(message: AppendMessage) => Promise<void>>();
  const onReloadRef = useRef<(parentId: string | null) => Promise<void>>();

  onNewRef.current = async (msg: AppendMessage) => {
    const userText = extractUserContent(msg);
    if (!userText.trim()) return;
    if (isGenerating) return;

    let convId = activeConversationId;
    if (!convId) {
      convId = createConversation();
    }

    const modelConfig = getModelConfig();
    if (!modelConfig) {
      addMessage(convId, { role: "user", content: userText });
      addMessage(convId, {
        role: "assistant",
        content: "请先在 **设置 → AI 模型** 中添加并启用至少一个模型。",
      });
      return;
    }

    if (!isTauriRuntime()) {
      addMessage(convId, { role: "user", content: userText });
      addMessage(convId, {
        role: "assistant",
        content:
          "AI 助手需要在 Tauri 桌面环境中运行，并先在设置中配置 AI 模型。",
      });
      return;
    }

    addMessage(convId, { role: "user", content: userText });

    const assistantMsgId = addMessage(convId, {
      role: "assistant",
      content: "",
      isStreaming: true,
      isReasoningStreaming: true,
    });

    const priorMessages = getPriorMessages(convId);
    await runGenerationRef.current!(convId, assistantMsgId, priorMessages, modelConfig);
  };

  onReloadRef.current = async (parentId) => {
    if (!parentId || isGenerating) return;

    let convId = activeConversationId;
    if (!convId) return;

    const modelConfig = getModelConfig();
    if (!modelConfig || !isTauriRuntime()) return;

    const conv = useAiStore.getState().conversations.find((c) => c.id === convId);
    if (!conv) return;

    const parentIndex = conv.messages.findIndex((m) => m.id === parentId);
    if (parentIndex < 0) return;

    const parentMsg = conv.messages[parentIndex];
    if (parentMsg.role !== "user") return;

    const priorMessages = conv.messages.slice(0, parentIndex + 1).slice(-20).map((m) => ({
      role: m.role,
      content: m.content,
      toolCalls: m.toolCalls?.map((tc) => ({
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
        result: tc.result,
      })),
    }));

    const assistantMsgId = addMessage(convId, {
      role: "assistant",
      content: "",
      isStreaming: true,
      isReasoningStreaming: true,
    });

    await runGenerationRef.current!(convId, assistantMsgId, priorMessages, modelConfig);
  };

  const handleCancel = useCallback(async () => {
    abortRef.current?.abort();
  }, []);

  const adapter = useMemo<ExternalStoreAdapter>(
    () => ({
      messages: threadMessages.length > 0 ? threadMessages : EMPTY_MESSAGE_LIST,
      isRunning: isGenerating,
      onNew: (msg) => onNewRef.current!(msg),
      setMessages: handleSetMessages,
      onReload: (parentId) => onReloadRef.current!(parentId),
      onCancel: handleCancel,
    }),
    [threadMessages, isGenerating, handleCancel, handleSetMessages],
  );

  const runtime = useExternalStoreRuntime(adapter);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  );
}
