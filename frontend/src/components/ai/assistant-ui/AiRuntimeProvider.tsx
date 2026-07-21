import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import type {
  AppendMessage,
  ExternalStoreAdapter,
  ThreadMessage,
} from "@assistant-ui/react";
import { useExternalStoreRuntime } from "@assistant-ui/react";

import type { AcpStreamEvent } from "../../../lib/acp/acpStream";
import { commands } from "../../../ipc/bindings";
import { resolveBackendFromSelection } from "../../../lib/ai/inferenceBackend";
import { runInternalAiChat } from "../../../lib/ai/orchestrator";
import { isTauriRuntime } from "../../../lib/isTauriRuntime";
import { resolveConversationModelSelectionId } from "../../../lib/aiScenarioModels";
import { resolveTerminalModelSelectionId } from "../../../lib/terminalScenarioModels";
import { useAiModelsStore } from "../../../stores/aiModelsStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { useTerminalStore } from "../../../stores/terminalStore";
import { registerAiPromptSubmit, type InlineTerminalAiTarget } from "../../../lib/ai/submitAiPrompt";
import { registerAiGenerationCancel } from "../../../lib/ai/cancelAiGeneration";
import { useBlocksStore, isAiThreadMessage } from "../../../stores/blocksStore";
import { useTerminalUiStore } from "../../../modules/terminal/terminalUiStore";
import {
  getResolvedAiThread,
  pushAssistantErrorMessage,
} from "../../../modules/terminal/aiThreadBridge";
import { buildTerminalAiContextAppend } from "../../../modules/terminal/buildTerminalAiContext";
import {
  resolveInlineConversationId,
  resolveTerminalAiContextBundle,
  terminalAiBundleToOrchestratorContext,
} from "../../../modules/terminal/terminalAiContextBundle";
import { buildInlineAiHistoryJson } from "../../../modules/terminal/terminalInlineAiHistory";
import { cancelPendingInlineTools } from "../../../modules/terminal/inlineToolBridge";
import {
  appendInlineAiStreamChunk,
  flushInlineAiStream,
} from "../../../modules/terminal/inlineAiStreamBuffer";
import {
  checkInlineAiStall,
  clearInlineAiWatchdog,
  resetInlineAiStall,
  touchInlineAiDelta,
} from "../../../modules/terminal/inlineAiWatchdog";
import { dispatchPendingTool } from "../../../lib/ai/internalToolBridge";
import { getModuleAiContextText } from "../../../lib/ai/context";
import {
  buildComposerExplicitContextAppend,
  mergeAiContextAppend,
} from "../../../lib/ai/composerContextAppend";
import { resolveFocusModuleKey } from "../../../lib/ai/resolveFocusModuleKey";
import { useAiStore, type ToolCallState } from "../../../stores/aiStore";
import {
  clearComposerContextItems,
  getComposerContextItems,
} from "../../../stores/aiComposerContextStore";
import { resolveKnowledgeEmbeddingProvider } from "../../../lib/knowledgeEmbeddingModel";
import { useSkillPromptStore } from "../../../stores/skillPromptStore";
import {
  aiMessagesToThreadMessages,
  threadMessagesToAiMessages,
} from "./messageBridge";
import { AcpPermissionDialog } from "./AcpPermissionDialog";

function extractUserContent(message: ThreadMessage | AppendMessage): string {
  for (const part of message.content) {
    if (part.type === "text") return part.text;
  }
  return "";
}

/**
 * 根据当前焦点 dock 解析 AI 工具过滤的 module_key。
 *
 * 优先级：
 * 1. activeDock.dockScope 前缀推断（焦点在 database dock → `database`）
 * 2. 回退到 `master`（全部工具）
 *
 * workspace:xxx / dashboard / 无焦点 → `master`
 *
 * 后端 list_enabled 已保证 Native 工具（knowledge/web/ssh 等通用能力）始终保留，
 * 因此这里只控制 UiDelegated 工具的模块范围。
 */
function resolveActiveModuleFilter(): string {
  return resolveFocusModuleKey() ?? "master";
}

/**
 * 解析知识库 RAG 注入用的 embedding provider 配置。
 *
 * 读取 settings + aiModelsStore 的 embedding 配置，未配置时返回 null（跳过 RAG）。
 * 与 mcpTools.ts 的 queryDocument 路径共用同一份 resolveKnowledgeEmbeddingProvider。
 */
function resolveKnowledgeEmbeddingProviderForRag() {
  const settings = useSettingsStore.getState();
  const providers = useAiModelsStore.getState().providers;
  return resolveKnowledgeEmbeddingProvider(providers, {
    knowledgeEmbeddingModelMode: settings.knowledgeEmbeddingModelMode,
    knowledgeEmbeddingModelSelectionId: settings.knowledgeEmbeddingModelSelectionId,
    knowledgeEmbeddingOllamaModel: settings.knowledgeEmbeddingOllamaModel,
  });
}

const EMPTY_MESSAGE_LIST: ThreadMessage[] = [];

const TERMINAL_CLIENT_TOOL = "omni_terminal_run_terminal_command";

function parseTerminalCommand(argsJson: string): string {
  try {
    const parsed = JSON.parse(argsJson || "{}") as { command?: string };
    if (typeof parsed.command === "string" && parsed.command.trim()) {
      return parsed.command.trim();
    }
  } catch {
    // ignore
  }
  return "";
}

function isTerminalClientTool(toolName: string): boolean {
  return toolName === TERMINAL_CLIENT_TOOL;
}

type PermissionEvent = Extract<AcpStreamEvent, { type: "permission_request" }>;
type StreamEventHandler = AcpStreamEvent;

function buildHistoryJson(convId: string): string | undefined {
  const conv = useAiStore.getState().conversations.find((c) => c.id === convId);
  if (!conv) return undefined;
  let messages = conv.messages.filter((m) => m.role === "user" || m.role === "assistant");
  if (messages.length > 0 && messages[messages.length - 1]?.role === "user") {
    messages = messages.slice(0, -1);
  }
  if (messages.length === 0) return undefined;
  return JSON.stringify(
    messages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
  );
}

function resolveBackendForGeneration(
  inline?: InlineTerminalAiTarget,
  conversationId?: string | null,
) {
  const providers = useAiModelsStore.getState().providers;
  const assistantDefaultId =
    useSettingsStore.getState().aiScenarioAssistantModelSelectionId;
  let selectionId: string | null;
  if (inline) {
    selectionId = resolveTerminalModelSelectionId(providers);
  } else {
    const conversation = conversationId
      ? useAiStore.getState().conversations.find((c) => c.id === conversationId)
      : undefined;
    const draftSelectionId = useAiStore.getState().currentModelSelectionId;
    selectionId = resolveConversationModelSelectionId(
      providers,
      conversation,
      assistantDefaultId,
      draftSelectionId,
    );
  }
  return resolveBackendFromSelection(providers, selectionId);
}

function buildAiContext(inline?: InlineTerminalAiTarget) {
  const activeConv = useAiStore.getState().conversations.find(
    (c) => c.id === useAiStore.getState().activeConversationId,
  );
  const linkedSession = !inline ? activeConv?.linkedTerminalSessionId : null;
  const tab = inline
    ? useTerminalStore.getState().tabs.find((t) => t.id === inline.sessionId)
    : useTerminalStore
        .getState()
        .tabs.find(
          (t) =>
            t.id ===
            (linkedSession || useTerminalStore.getState().activeTabId),
        );
  const sessionId = inline?.sessionId ?? tab?.id ?? null;

  // 焦点模块自动上下文（terminal 走 terminalContextAppend，避免重复）。
  const focusModule = resolveFocusModuleKey();
  const focusModuleAppend =
    focusModule && focusModule !== "terminal"
      ? getModuleAiContextText(focusModule)
      : null;
  // Composer 显式多选芯片（发送时注入）。
  const explicitAppend = buildComposerExplicitContextAppend(getComposerContextItems());
  const moduleContextAppend = mergeAiContextAppend(focusModuleAppend, explicitAppend);

  if (!sessionId) {
    return {
      cwd: null,
      workspaceId: null,
      terminalSessionId: null,
      terminalSessionType: null,
      envTag: null,
      resourceId: null,
      terminalContextAppend: null,
      moduleContextAppend,
    };
  }
  const bundle = resolveTerminalAiContextBundle(
    sessionId,
    inline ? "terminal-inline" : "assistant",
  );
  if (!bundle) {
    return {
      cwd: null,
      workspaceId: null,
      terminalSessionId: sessionId,
      terminalSessionType: tab?.session.type ?? null,
      envTag: null,
      resourceId: tab?.session.resourceId ?? null,
      terminalContextAppend: buildTerminalAiContextAppend(sessionId),
      moduleContextAppend,
    };
  }
  return {
    ...terminalAiBundleToOrchestratorContext(bundle),
    moduleContextAppend,
  };
}

function handleStreamEvent(
  event: StreamEventHandler,
  handlers: {
    appendText: (chunk: string) => void;
    appendReasoning: (chunk: string) => void;
    upsertToolCall: (id: string, name: string, args: string) => void;
    updateToolCall: (id: string, status: string, result?: string) => void;
    enqueuePermission: (event: PermissionEvent) => void;
    finishGeneration: (failed?: boolean) => void;
    setIsGenerating: (v: boolean) => void;
  },
  signal: AbortSignal,
): boolean {
  if (signal.aborted) return true;
  switch (event.type) {
    case "content_delta":
      handlers.appendText(event.text);
      break;
    case "reasoning_delta":
      handlers.appendReasoning(event.text);
      break;
    case "tool_call":
      handlers.upsertToolCall(event.id, event.name, event.arguments);
      break;
    case "tool_call_update":
      handlers.updateToolCall(event.id, event.status, event.result ?? undefined);
      break;
    case "permission_request":
      handlers.enqueuePermission(event);
      break;
    case "error":
      handlers.appendText(`\n\nError: ${event.message}`);
      break;
    case "done":
      handlers.finishGeneration();
      handlers.setIsGenerating(false);
      return true;
    default:
      break;
  }
  return false;
}

function inlineHasAssistantContent(blockId: string): boolean {
  const block = useBlocksStore.getState().findBlockById(blockId);
  if (!block) return false;
  return getResolvedAiThread(block).some(
    (item) =>
      isAiThreadMessage(item) &&
      item.role === "assistant" &&
      Boolean(item.content.trim() || item.reasoning?.trim()),
  );
}

function finalizeInlineBlock(
  inline: InlineTerminalAiTarget,
  options: { failed: boolean; aborted?: boolean; reason?: string },
): void {
  flushInlineAiStream(inline.blockId, inline.assistantTurnId);
  clearInlineAiWatchdog(inline.blockId);
  useBlocksStore.getState().updateBlock(inline.blockId, { aiStalled: false });
  if (options.aborted) {
    cancelPendingInlineTools(inline.blockId);
  }
  if (options.reason && !inlineHasAssistantContent(inline.blockId)) {
    pushAssistantErrorMessage(inline.blockId, options.reason);
  }
  useBlocksStore.getState().updateBlock(inline.blockId, {
    status: options.failed ? "failed" : "completed",
    exitCode: options.failed ? (options.aborted ? 130 : 1) : 0,
  });
  useTerminalUiStore.getState().setExpandedAiBlock(inline.sessionId, inline.blockId);
}

function mapToolStatus(status: string): ToolCallState["status"] {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "pending") return "pending";
  return "running";
}

export function AiRuntimeProvider({ children }: { children: ReactNode }) {
  const conversations = useAiStore((s) => s.conversations);
  const activeConversationId = useAiStore((s) => s.activeConversationId);
  const isGenerating = useAiStore((s) => s.isGenerating);
  const addMessage = useAiStore((s) => s.addMessage);
  const updateMessage = useAiStore((s) => s.updateMessage);
  const appendStreamContent = useAiStore((s) => s.appendStreamContent);
  const appendStreamReasoning = useAiStore((s) => s.appendStreamReasoning);
  const upsertStreamToolCall = useAiStore((s) => s.upsertStreamToolCall);
  const updateStreamToolCall = useAiStore((s) => s.updateStreamToolCall);
  const setIsGenerating = useAiStore((s) => s.setIsGenerating);
  const createConversation = useAiStore((s) => s.createConversation);
  const replaceConversationMessages = useAiStore((s) => s.replaceConversationMessages);

  const abortRef = useRef<AbortController | null>(null);
  const permissionQueueRef = useRef<PermissionEvent[]>([]);
  const toolMetaRef = useRef(new Map<string, { name: string; args: string }>());
  const pendingToolBridgeRef = useRef(new Set<string>());
  const waitingToolDispatchRef = useRef(new Set<string>());
  const [permissionRequest, setPermissionRequest] = useState<PermissionEvent | null>(null);

  const activeConversation = conversations.find((c) => c.id === activeConversationId);

  const [threadMessages, setThreadMessages] = useState<ThreadMessage[]>([]);

  useEffect(() => {
    if (!activeConversation) {
      setThreadMessages([]);
      return;
    }
    setThreadMessages(aiMessagesToThreadMessages(activeConversation.messages));
  }, [activeConversation]);

  const showNextPermission = useCallback(() => {
    const next = permissionQueueRef.current.shift() ?? null;
    setPermissionRequest(next);
  }, []);

  const enqueuePermission = useCallback(
    (event: PermissionEvent) => {
      if (!permissionRequest) {
        setPermissionRequest(event);
        return;
      }
      permissionQueueRef.current.push(event);
    },
    [permissionRequest],
  );

  const handlePermissionClose = useCallback(() => {
    showNextPermission();
  }, [showNextPermission]);

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
        assistantMsgId: string | null,
        userText: string,
        inline?: InlineTerminalAiTarget,
      ) => Promise<void>
    >(undefined);

  runGenerationRef.current = async (convId, assistantMsgId, userText, inline) => {
    const appendText = (chunk: string) => {
      if (inline?.assistantTurnId) {
        touchInlineAiDelta(inline.blockId);
        const block = useBlocksStore.getState().findBlockById(inline.blockId);
        if (block && (block.status !== "running" || block.aiStalled)) {
          useBlocksStore.getState().updateBlock(inline.blockId, {
            status: "running",
            exitCode: null,
            aiStalled: false,
          });
        }
        appendInlineAiStreamChunk(
          inline.blockId,
          inline.assistantTurnId,
          "content",
          chunk,
        );
      } else if (assistantMsgId) {
        appendStreamContent(convId, assistantMsgId, chunk);
      }
    };

    const appendReasoning = (chunk: string) => {
      if (inline?.assistantTurnId) {
        touchInlineAiDelta(inline.blockId);
        const block = useBlocksStore.getState().findBlockById(inline.blockId);
        if (block && (block.status !== "running" || block.aiStalled)) {
          useBlocksStore.getState().updateBlock(inline.blockId, {
            status: "running",
            exitCode: null,
            aiStalled: false,
          });
        }
        appendInlineAiStreamChunk(
          inline.blockId,
          inline.assistantTurnId,
          "reasoning",
          chunk,
        );
      } else if (assistantMsgId) {
        appendStreamReasoning(convId, assistantMsgId, chunk);
      }
    };

    const aiContext = buildAiContext(inline);
    // 显式芯片已写入本次请求上下文，发送后清空（与附件行为一致）。
    const explicitItems = getComposerContextItems();
    if (!inline && explicitItems.length > 0) {
      for (const item of explicitItems) {
        useAiStore.getState().addContext(convId, {
          type: item.kind,
          label: item.label,
        });
      }
    }
    clearComposerContextItems();

    const tryDispatchTool = (id: string) => {
      if (pendingToolBridgeRef.current.has(id)) return;
      const meta = toolMetaRef.current.get(id);
      if (!meta) return;
      if (isTerminalClientTool(meta.name) && !parseTerminalCommand(meta.args)) {
        waitingToolDispatchRef.current.add(id);
        return;
      }
      waitingToolDispatchRef.current.delete(id);
      pendingToolBridgeRef.current.add(id);
      const done = () => pendingToolBridgeRef.current.delete(id);
      void dispatchPendingTool({
        conversationId: convId,
        toolCallId: id,
        toolName: meta.name,
        argsJson: meta.args,
        inline: inline ? { blockId: inline.blockId, sessionId: inline.sessionId } : null,
        terminalSessionId: aiContext.terminalSessionId,
      }).finally(done);
    };

    const upsertToolCall = (id: string, name: string, args: string) => {
      if (!name.trim()) return;
      toolMetaRef.current.set(id, { name, args });
      if (inline) {
        const block = useBlocksStore.getState().findBlockById(inline.blockId);
        const exists =
          block &&
          getResolvedAiThread(block).some(
            (item) => item.kind === "tool_call" && item.id === id,
          );
        if (exists) {
          // 完整 arguments 重播：更新已存在的 tool call，供 dock 解析完整命令。
          useBlocksStore.getState().updateAiThreadItem(inline.blockId, id, {
            toolName: name,
            args,
          });
        } else {
          useBlocksStore.getState().pushAiThreadItem(inline.blockId, {
            kind: "tool_call",
            id,
            toolName: name,
            args,
            status: "running",
          });
        }
        if (waitingToolDispatchRef.current.has(id)) {
          tryDispatchTool(id);
        }
        return;
      }
      if (!assistantMsgId) return;
      upsertStreamToolCall(convId, assistantMsgId, id, name, args);
      if (waitingToolDispatchRef.current.has(id)) {
        tryDispatchTool(id);
      }
    };

    const updateToolCall = (id: string, status: string, result?: string) => {
      // 工具进入 pending：统一分派——终端走内联审批 dock / 侧栏执行桥，
      // 其余 UiDelegated 工具走注册的 handler，全部回传 ai_chat_tool_result。
      if (status === "pending") {
        const meta = toolMetaRef.current.get(id);
        if (meta) {
          if (
            isTerminalClientTool(meta.name) &&
            !parseTerminalCommand(meta.args)
          ) {
            waitingToolDispatchRef.current.add(id);
          } else {
            tryDispatchTool(id);
          }
        }
      }

      // Skill 自我进化信号：omni_skill_* 工具成功完成时记录硬信号
      // （skill_recalled → 用户在重复解决问题，提醒提取/沉淀为 skill）
      if (status === "completed") {
        const meta = toolMetaRef.current.get(id);
        if (meta) {
          if (meta.name === "omni_skill_recall") {
            useSkillPromptStore.getState().recordSignal("skill_recalled", {
              contextSummary: meta.args,
            });
          } else if (meta.name === "omni_skill_extract_experience") {
            useSkillPromptStore.getState().recordSignal("skill_extracted", {
              contextSummary: meta.args,
            });
          } else if (meta.name === "omni_skill_refine") {
            useSkillPromptStore.getState().recordSignal("skill_refined", {
              contextSummary: meta.args,
            });
          }
        }
      }

      if (inline) {
        useBlocksStore.getState().updateAiThreadItem(inline.blockId, id, {
          status: mapToolStatus(status),
          result,
        });
        return;
      }
      if (!assistantMsgId) return;
      updateStreamToolCall(convId, assistantMsgId, id, mapToolStatus(status), result);
    };

    setIsGenerating(true);
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    const signal = abortRef.current.signal;
    toolMetaRef.current.clear();
    pendingToolBridgeRef.current.clear();
    waitingToolDispatchRef.current.clear();

    let stallTimer: ReturnType<typeof setInterval> | null = null;
    if (inline) {
      resetInlineAiStall(inline.blockId);
      // 生成开始时强制 running，避免被历史同步/恢复误标 failed 后一直显示 ✕
      useBlocksStore.getState().updateBlock(inline.blockId, {
        status: "running",
        exitCode: null,
        aiStalled: false,
      });
      stallTimer = setInterval(() => {
        if (signal.aborted) return;
        if (checkInlineAiStall(inline.blockId)) {
          useBlocksStore.getState().updateBlock(inline.blockId, { aiStalled: true });
        }
      }, 5_000);
    }

    // 清理历史轮次遗留的 streaming 状态（此前 panic/中断时可能未复位）
    if (!inline && assistantMsgId) {
      const conv = useAiStore.getState().conversations.find((c) => c.id === convId);
      for (const msg of conv?.messages ?? []) {
        if (msg.role === "assistant" && msg.id !== assistantMsgId && msg.isStreaming) {
          updateMessage(convId, msg.id, {
            isStreaming: false,
            isReasoningStreaming: false,
          });
        }
      }
    }

    const finishGeneration = (failed = false, aborted = false) => {
      if (inline) {
        flushInlineAiStream(inline.blockId, inline.assistantTurnId);
        if (aborted) {
          finalizeInlineBlock(inline, { failed: true, aborted: true, reason: "已停止" });
        } else {
          finalizeInlineBlock(inline, { failed });
        }
      } else if (assistantMsgId) {
        updateMessage(convId, assistantMsgId, {
          isStreaming: false,
          isReasoningStreaming: false,
        });
      }
    };

    try {
        const backend = resolveBackendForGeneration(inline, convId);
        if (!backend) {
          throw new Error("请先在设置中配置并选择 AI 模型或 Agent");
        }

        await runInternalAiChat({
          request: {
            conversationId: convId,
            userText,
            backendId: backend.backendId,
            httpProvider: backend.kind === "http" ? backend.httpProvider : null,
            context: aiContext,
            historyJson: inline
              ? await buildInlineAiHistoryJson(inline.blockId, { excludeLatestUser: true })
              : buildHistoryJson(convId),
            toolsMode: backend.kind === "http" ? { directInject: { moduleFilter: resolveActiveModuleFilter() } } : "none",
            // 知识库 RAG 自动注入：仅在 HTTP 后端（DirectInject）时生效
            embeddingProvider:
              backend.kind === "http" ? resolveKnowledgeEmbeddingProviderForRag() : null,
          },
          signal,
          onEvent: (event) => {
            const done = handleStreamEvent(
              event,
              {
                appendText,
                appendReasoning,
                upsertToolCall,
                updateToolCall,
                enqueuePermission,
                finishGeneration,
                setIsGenerating,
              },
              signal,
            );
            if (done) return;
          },
        });
      finishGeneration();
    } catch (err) {
      if (inline) {
        flushInlineAiStream(inline.blockId, inline.assistantTurnId);
      }
      if (signal.aborted) {
        finishGeneration(true, true);
      } else {
        const message = err instanceof Error ? err.message : String(err);
        appendText(`\n\nError: ${message}`);
        if (inline && !inlineHasAssistantContent(inline.blockId)) {
          pushAssistantErrorMessage(inline.blockId, message || "AI 请求失败");
        }
        finishGeneration(true);
      }
    } finally {
      if (stallTimer) clearInterval(stallTimer);
      setIsGenerating(false);
      abortRef.current = null;
    }
  };

  const runUserPromptRef =
    useRef<
      (
        userText: string,
        options?: {
          newConversation?: boolean;
          contextChips?: { type: string; label: string }[];
          inline?: InlineTerminalAiTarget;
        },
      ) => Promise<void>
    >(undefined);

  runUserPromptRef.current = async (userText, options) => {
    if (!userText.trim()) return;
    if (useAiStore.getState().isGenerating) {
      if (options?.inline) {
        abortRef.current?.abort();
        setIsGenerating(false);
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      } else {
        return;
      }
    }

    if (options?.inline) {
      const { blockId, sessionId, continueThread } = options.inline;
      if (!isTauriRuntime()) {
        pushAssistantErrorMessage(blockId, "AI 助手需要在 Tauri 桌面环境中运行。");
        useBlocksStore.getState().updateBlock(blockId, { status: "failed", exitCode: 1 });
        return;
      }

      const convId = resolveInlineConversationId(sessionId);

      const assistantTurnId = useBlocksStore.getState().pushAiThreadItem(blockId, {
        kind: "message",
        role: "assistant",
        content: "",
        reasoning: "",
      });

      useTerminalUiStore.getState().setExpandedAiBlock(sessionId, blockId);

      const inlineTarget: InlineTerminalAiTarget = {
        sessionId,
        blockId,
        continueThread,
        assistantTurnId,
      };

      await runGenerationRef.current!(convId, null, userText, inlineTarget);
      return;
    }

    let convId = options?.newConversation ? null : useAiStore.getState().activeConversationId;
    if (!convId) {
      convId = createConversation();
    }

    if (options?.contextChips) {
      for (const chip of options.contextChips) {
        useAiStore.getState().addContext(convId, chip);
      }
    }

    if (!isTauriRuntime()) {
      addMessage(convId, { role: "user", content: userText });
      addMessage(convId, {
        role: "assistant",
        content: "AI 助手需要在 Tauri 桌面环境中运行，并先在设置中配置 AI 模型。",
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

    await runGenerationRef.current!(convId, assistantMsgId, userText);
  };

  const onNewRef = useRef<(message: AppendMessage) => Promise<void>>(undefined);
  const onReloadRef = useRef<(parentId: string | null) => Promise<void>>(undefined);

  onNewRef.current = async (msg) => {
    await runUserPromptRef.current!(extractUserContent(msg));
  };

  onReloadRef.current = async (parentId) => {
    if (!parentId || isGenerating) return;
    const convId = activeConversationId;
    if (!convId || !isTauriRuntime()) return;

    const conv = useAiStore.getState().conversations.find((c) => c.id === convId);
    if (!conv) return;

    const parentIndex = conv.messages.findIndex((m) => m.id === parentId);
    if (parentIndex < 0) return;
    const parentMsg = conv.messages[parentIndex];
    if (parentMsg.role !== "user") return;

    const assistantMsgId = addMessage(convId, {
      role: "assistant",
      content: "",
      isStreaming: true,
      isReasoningStreaming: true,
    });

    await runGenerationRef.current!(convId, assistantMsgId, parentMsg.content);
  };

  const handleCancel = useCallback(async () => {
    abortRef.current?.abort();
    const convId = useAiStore.getState().activeConversationId;
    if (convId) {
      void commands.aiChatCancel(convId).catch(() => {});
      const conv = useAiStore.getState().conversations.find((c) => c.id === convId);
      for (const msg of conv?.messages ?? []) {
        if (msg.role === "assistant" && msg.isStreaming) {
          updateMessage(convId, msg.id, {
            isStreaming: false,
            isReasoningStreaming: false,
          });
        }
      }
    }
    cancelPendingInlineTools();
    setIsGenerating(false);
  }, [setIsGenerating, updateMessage]);

  useEffect(() => {
    return registerAiPromptSubmit((prompt, options) => runUserPromptRef.current!(prompt, options));
  }, []);

  useEffect(() => {
    return registerAiGenerationCancel(handleCancel);
  }, [handleCancel]);

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
      <AcpPermissionDialog request={permissionRequest} onClose={handlePermissionClose} />
    </AssistantRuntimeProvider>
  );
}
