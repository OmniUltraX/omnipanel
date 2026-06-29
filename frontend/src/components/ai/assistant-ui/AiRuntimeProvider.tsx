import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import type {
  AppendMessage,
  ExternalStoreAdapter,
  ThreadMessage,
} from "@assistant-ui/react";
import { useExternalStoreRuntime } from "@assistant-ui/react";

import { runAcpPrompt, type AcpStreamEvent } from "../../../lib/acp/acpStream";
import { isTauriRuntime } from "../../../lib/isTauriRuntime";
import { registerAiPromptSubmit, type InlineTerminalAiTarget } from "../../../lib/ai/submitAiPrompt";
import { registerAiGenerationCancel } from "../../../lib/ai/cancelAiGeneration";
import { useBlocksStore, isAiThreadMessage } from "../../../stores/blocksStore";
import { useTerminalUiStore } from "../../../modules/terminal/terminalUiStore";
import {
  getResolvedAiThread,
  pushAssistantErrorMessage,
} from "../../../modules/terminal/aiThreadBridge";
import { cancelPendingInlineTools } from "../../../modules/terminal/inlineToolBridge";
import { useAiStore, type ToolCallState } from "../../../stores/aiStore";

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

const EMPTY_MESSAGE_LIST: ThreadMessage[] = [];

type PermissionEvent = Extract<AcpStreamEvent, { type: "permission_request" }>;

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
  const setIsGenerating = useAiStore((s) => s.setIsGenerating);
  const createConversation = useAiStore((s) => s.createConversation);
  const replaceConversationMessages = useAiStore((s) => s.replaceConversationMessages);

  const abortRef = useRef<AbortController | null>(null);
  const permissionQueueRef = useRef<PermissionEvent[]>([]);
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
        useBlocksStore
          .getState()
          .appendAiThreadMessageField(inline.blockId, inline.assistantTurnId, "content", chunk);
      } else if (assistantMsgId) {
        appendStreamContent(convId, assistantMsgId, chunk);
      }
    };

    const appendReasoning = (chunk: string) => {
      if (inline?.assistantTurnId) {
        useBlocksStore
          .getState()
          .appendAiThreadMessageField(inline.blockId, inline.assistantTurnId, "reasoning", chunk);
      } else if (assistantMsgId) {
        appendStreamReasoning(convId, assistantMsgId, chunk);
      }
    };

    const upsertToolCall = (id: string, name: string, args: string) => {
      if (inline) {
        useBlocksStore.getState().pushAiThreadItem(inline.blockId, {
          kind: "tool_call",
          id,
          toolName: name,
          args,
          status: "running",
        });
        return;
      }
      if (!assistantMsgId) return;
      const conv = useAiStore.getState().conversations.find((c) => c.id === convId);
      const msg = conv?.messages.find((m) => m.id === assistantMsgId);
      const existing = msg?.toolCalls ?? [];
      if (existing.some((tc) => tc.id === id)) return;
      updateMessage(convId, assistantMsgId, {
        toolCalls: [...existing, { id, name, arguments: args, status: "running" }],
      });
    };

    const updateToolCall = (id: string, status: string, result?: string) => {
      if (inline) {
        useBlocksStore.getState().updateAiThreadItem(inline.blockId, id, {
          status: mapToolStatus(status),
          result,
        });
        return;
      }
      if (!assistantMsgId) return;
      updateMessage(convId, assistantMsgId, {
        toolCalls: useAiStore
          .getState()
          .conversations.find((c) => c.id === convId)
          ?.messages.find((m) => m.id === assistantMsgId)
          ?.toolCalls?.map((tc) =>
            tc.id === id
              ? {
                  ...tc,
                  status: mapToolStatus(status),
                  result,
                }
              : tc,
          ),
      });
    };

    setIsGenerating(true);
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    const signal = abortRef.current.signal;

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
      await runAcpPrompt({
        conversationId: convId,
        userText,
        signal,
        onEvent: (event) => {
          if (signal.aborted) return;
          switch (event.type) {
            case "content_delta":
              appendText(event.text);
              break;
            case "reasoning_delta":
              appendReasoning(event.text);
              break;
            case "tool_call":
              upsertToolCall(event.id, event.name, event.arguments);
              break;
            case "tool_call_update":
              updateToolCall(event.id, event.status, event.result ?? undefined);
              break;
            case "permission_request":
              enqueuePermission(event);
              break;
            case "error":
              appendText(`\n\nError: ${event.message}`);
              break;
            case "done":
              finishGeneration();
              setIsGenerating(false);
              break;
          }
        },
      });
      finishGeneration();
    } catch (err) {
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

      let convId = useAiStore.getState().activeConversationId ?? createConversation();
      if (!useAiStore.getState().activeConversationId) {
        useAiStore.getState().setActiveConversation(convId);
      }

      const assistantTurnId = useBlocksStore.getState().pushAiThreadItem(blockId, {
        kind: "message",
        role: "assistant",
        content: "",
        reasoning: "",
      });

      useTerminalUiStore.getState().setExpandedAiBlock(sessionId, blockId);

      if (!continueThread) {
        addMessage(convId, { role: "user", content: userText });
      }

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
        content: "AI 助手需要在 Tauri 桌面环境中运行，并先在设置中连接 ACP Agent。",
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
    setIsGenerating(false);
  }, [setIsGenerating]);

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
