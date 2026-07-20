import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { WorkspaceContextSnapshot } from "./workspaceStore";
import { useWorkspaceStore } from "./workspaceStore";
import {
  parseModelSelectionId,
  resolveModelSelection,
  useAiModelsStore,
} from "./aiModelsStore";
import { useSettingsStore } from "./settingsStore";
import { resolveScenarioModelSelectionId } from "../lib/aiScenarioModels";

export interface ToolCallState {
  id: string;
  name: string;
  arguments: string;
  result?: string;
  status: "pending" | "running" | "completed" | "failed";
}

export interface AgentMcpConnection {
  serviceId: string;
  serviceName: string;
  builtin: boolean;
  toolCount: number;
}

export interface AiMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  /** 推理模型返回的思考过程（reasoning_content） */
  reasoningContent?: string;
  timestamp: number;
  toolCalls?: ToolCallState[];
  isStreaming?: boolean;
  isReasoningStreaming?: boolean;
}

/** 推理强度（OpenAI / DeepSeek 等兼容 API 的 reasoning_effort） */
export type ReasoningEffortLevel = "default" | "low" | "medium" | "high";

export interface AiConversation {
  id: string;
  title: string;
  messages: AiMessage[];
  provider: string;
  model: string;
  /** 当前会话选用的模型（aiModelsStore selectionId 或 cli/acp backend id） */
  modelSelectionId?: string | null;
  createdAt: number;
  updatedAt: number;
  context?: { type: string; label: string }[];
  contextSnapshot?: WorkspaceContextSnapshot;
  /** 显式钉住的工作区（可选；null/undefined=全局作用域） */
  pinnedWorkspaceId?: string | null;
  /** 附着的终端 session（Dock ↔ 终端互通） */
  linkedTerminalSessionId?: string | null;
  /** 由内联 AI Promote 而来的源 block */
  sourceBlockId?: string | null;
}

interface AiStore {
  conversations: AiConversation[];
  activeConversationId: string | null;
  drawerOpen: boolean;
  currentProvider: string;
  currentModel: string;
  /** aiModelsStore 中的 providerId::modelName */
  currentModelSelectionId: string | null;
  isGenerating: boolean;
  draftPrompt: string;
  /** 推理程度，default 表示不传给 API */
  reasoningEffort: ReasoningEffortLevel;
  /** 当前智能体已连接的 MCP 服务（打开助手或发送消息时刷新） */
  connectedMcpServices: AgentMcpConnection[];
  /** 右侧会话列表面板是否展开 */
  conversationListOpen: boolean;
  /** 会话列表面板宽度（px） */
  conversationListWidth: number;

  toggleDrawer: () => void;
  openDrawer: () => void;
  closeDrawer: () => void;
  createConversation: (provider?: string, model?: string) => string;
  setActiveConversation: (id: string) => void;
  renameConversation: (id: string, title: string) => void;
  deleteConversation: (id: string) => void;
  addMessage: (
    conversationId: string,
    msg: Omit<AiMessage, "id" | "timestamp">
  ) => string;
  updateMessage: (
    conversationId: string,
    messageId: string,
    update: Partial<AiMessage>
  ) => void;
  appendStreamContent: (
    conversationId: string,
    messageId: string,
    chunk: string
  ) => void;
  appendStreamReasoning: (
    conversationId: string,
    messageId: string,
    chunk: string
  ) => void;
  setCurrentProvider: (provider: string, model: string) => void;
  setCurrentModelSelectionId: (id: string | null) => void;
  setIsGenerating: (v: boolean) => void;
  setDraftPrompt: (prompt: string) => void;
  clearDraftPrompt: () => void;
  setContext: (conversationId: string, context: { type: string; label: string }[]) => void;
  addContext: (conversationId: string, chip: { type: string; label: string }) => void;
  removeContext: (conversationId: string, type: string) => void;
  setReasoningEffort: (level: ReasoningEffortLevel) => void;
  setConnectedMcpServices: (connections: AgentMcpConnection[]) => void;
  toggleConversationList: () => void;
  setConversationListOpen: (open: boolean) => void;
  setConversationListWidth: (width: number) => void;
  setConversationModelSelectionId: (conversationId: string, selectionId: string) => void;
  replaceConversationMessages: (conversationId: string, messages: AiMessage[]) => void;
  /** 显式钉住工作区；传 null 恢复全局作用域 */
  pinConversationWorkspace: (conversationId: string, workspaceId: string | null) => void;
  attachTerminalSession: (conversationId: string, sessionId: string | null) => void;
  /**
   * 将终端内联 aiThread 投影为 Dock 会话（或写入指定会话）。
   * 返回目标 conversationId。
   */
  promoteInlineThread: (args: {
    title: string;
    messages: AiMessage[];
    terminalSessionId: string;
    sourceBlockId: string;
    targetConversationId?: string | null;
  }) => string;
}

let idCounter = 0;
function genId(prefix: string): string {
  return `${prefix}_${Date.now()}_${++idCounter}`;
}

export const useAiStore = create<AiStore>()(
  persist(
    (set, get) => ({
      conversations: [],
      activeConversationId: null,
      drawerOpen: false,
      currentProvider: "openai",
      currentModel: "gpt-4o",
      currentModelSelectionId: null,
      isGenerating: false,
      draftPrompt: "",
      reasoningEffort: "medium",
      connectedMcpServices: [],
      conversationListOpen: false,
      conversationListWidth: 240,

      toggleDrawer: () =>
        set((state) => ({ drawerOpen: !state.drawerOpen })),

      openDrawer: () => set({ drawerOpen: true }),

      closeDrawer: () => set({ drawerOpen: false }),

      createConversation: (provider, model) => {
        const id = genId("conv");
        const state = get();
        const snapshot = useWorkspaceStore.getState().getSnapshot();
        const providers = useAiModelsStore.getState().providers;
        const modelSelectionId = resolveScenarioModelSelectionId(
          providers,
          state.currentModelSelectionId ??
            useSettingsStore.getState().aiScenarioAssistantModelSelectionId,
        );
        const parsed = modelSelectionId ? parseModelSelectionId(modelSelectionId) : null;
        const resolved = modelSelectionId
          ? resolveModelSelection(providers, modelSelectionId)
          : null;
        const conv: AiConversation = {
          id,
          title: "新的对话",
          messages: [],
          provider: provider || parsed?.providerId || state.currentProvider,
          model: model || parsed?.modelName || resolved?.name || state.currentModel,
          modelSelectionId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          contextSnapshot: snapshot,
          // 工作区非必选：仅记录现场快照芯片，不自动 pin 工作区
          pinnedWorkspaceId: null,
          linkedTerminalSessionId: null,
          sourceBlockId: null,
          context: [
            ...(snapshot.activeResource
              ? [{ type: "resource", label: snapshot.activeResource.name }]
              : []),
          ],
        };
        set((s) => ({
          conversations: [conv, ...s.conversations],
          activeConversationId: id,
        }));
        return id;
      },

      setActiveConversation: (id) => {
        const conversation = get().conversations.find((c) => c.id === id);
        set({
          activeConversationId: id,
          ...(conversation?.modelSelectionId
            ? { currentModelSelectionId: conversation.modelSelectionId }
            : {}),
        });
      },

      renameConversation: (id, title) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === id ? { ...c, title, updatedAt: Date.now() } : c,
          ),
        })),

      deleteConversation: (id) =>
        set((state) => {
          const remaining = state.conversations.filter((c) => c.id !== id);
          const newActive =
            state.activeConversationId === id
              ? remaining.length > 0
                ? remaining[0].id
                : null
              : state.activeConversationId;
          return {
            conversations: remaining,
            activeConversationId: newActive,
          };
        }),

      addMessage: (conversationId, msg) => {
        const msgId = genId("msg");
        const fullMsg: AiMessage = {
          ...msg,
          id: msgId,
          timestamp: Date.now(),
        };
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c;
            const messages = [...c.messages, fullMsg];
            // Auto-title from first user message
            const title =
              c.title === "新的对话" && msg.role === "user"
                ? msg.content.slice(0, 50) + (msg.content.length > 50 ? "..." : "")
                : c.title;
            return {
              ...c,
              messages,
              title,
              updatedAt: Date.now(),
            };
          }),
        }));
        return msgId;
      },

      updateMessage: (conversationId, messageId, update) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c;
            return {
              ...c,
              messages: c.messages.map((m) =>
                m.id === messageId ? { ...m, ...update } : m
              ),
              updatedAt: Date.now(),
            };
          }),
        })),

      appendStreamContent: (conversationId, messageId, chunk) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c;
            return {
              ...c,
              messages: c.messages.map((m) =>
                m.id === messageId
                  ? {
                      ...m,
                      content: m.content + chunk,
                      isReasoningStreaming: chunk ? false : m.isReasoningStreaming,
                    }
                  : m
              ),
            };
          }),
        })),

      appendStreamReasoning: (conversationId, messageId, chunk) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c;
            return {
              ...c,
              messages: c.messages.map((m) =>
                m.id === messageId
                  ? {
                      ...m,
                      reasoningContent: (m.reasoningContent ?? "") + chunk,
                      isReasoningStreaming: true,
                    }
                  : m
              ),
            };
          }),
        })),

      setCurrentProvider: (provider, model) =>
        set({ currentProvider: provider, currentModel: model }),

      setCurrentModelSelectionId: (id) => set({ currentModelSelectionId: id }),

      setIsGenerating: (v) => set({ isGenerating: v }),

      setDraftPrompt: (prompt) => set({ draftPrompt: prompt }),

      clearDraftPrompt: () => set({ draftPrompt: "" }),

      setContext: (conversationId, context) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId ? { ...c, context } : c
          ),
        })),

      addContext: (conversationId, chip) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c;
            const existing = c.context || [];
            if (existing.some((ch) => ch.type === chip.type && ch.label === chip.label)) return c;
            return { ...c, context: [...existing, chip] };
          }),
        })),

      removeContext: (conversationId, type) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c;
            return {
              ...c,
              context: (c.context || []).filter((ch) => ch.type !== type),
            };
          }),
        })),

      setReasoningEffort: (level) => set({ reasoningEffort: level }),

      setConnectedMcpServices: (connections) => set({ connectedMcpServices: connections }),

      toggleConversationList: () =>
        set((state) => ({ conversationListOpen: !state.conversationListOpen })),

      setConversationListOpen: (open) => set({ conversationListOpen: open }),

      setConversationListWidth: (width) =>
        set({ conversationListWidth: Math.max(180, Math.min(420, width)) }),

      setConversationModelSelectionId: (conversationId, selectionId) => {
        const providers = useAiModelsStore.getState().providers;
        const parsed = parseModelSelectionId(selectionId);
        const resolved = resolveModelSelection(providers, selectionId);
        set((state) => ({
          currentModelSelectionId: selectionId,
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c;
            return {
              ...c,
              modelSelectionId: selectionId,
              provider: parsed?.providerId ?? c.provider,
              model: parsed?.modelName ?? resolved?.name ?? c.model,
              updatedAt: Date.now(),
            };
          }),
        }));
      },

      replaceConversationMessages: (conversationId, messages) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? { ...c, messages: [...messages], updatedAt: Date.now() }
              : c,
          ),
        })),

      pinConversationWorkspace: (conversationId, workspaceId) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c;
            const ws = workspaceId
              ? useWorkspaceStore.getState().workspaces.find((w) => w.id === workspaceId)
              : null;
            const context = (c.context || []).filter((ch) => ch.type !== "workspace");
            if (ws) {
              context.unshift({ type: "workspace", label: ws.name });
            }
            return {
              ...c,
              pinnedWorkspaceId: workspaceId,
              context,
              updatedAt: Date.now(),
            };
          }),
        })),

      attachTerminalSession: (conversationId, sessionId) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? { ...c, linkedTerminalSessionId: sessionId, updatedAt: Date.now() }
              : c,
          ),
        })),

      promoteInlineThread: ({
        title,
        messages,
        terminalSessionId,
        sourceBlockId,
        targetConversationId,
      }) => {
        const state = get();
        if (targetConversationId) {
          set({
            conversations: state.conversations.map((c) =>
              c.id === targetConversationId
                ? {
                    ...c,
                    messages: [...c.messages, ...messages],
                    linkedTerminalSessionId: terminalSessionId,
                    sourceBlockId,
                    title: c.title === "新的对话" ? title : c.title,
                    updatedAt: Date.now(),
                  }
                : c,
            ),
            activeConversationId: targetConversationId,
          });
          return targetConversationId;
        }
        const id = get().createConversation();
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id === id
              ? {
                  ...c,
                  title,
                  messages,
                  linkedTerminalSessionId: terminalSessionId,
                  sourceBlockId,
                  updatedAt: Date.now(),
                }
              : c,
          ),
        }));
        return id;
      },
    }),
    {
      name: "omnipanel-ai-store",
      partialize: (state) => ({
        conversations: state.conversations,
        activeConversationId: state.activeConversationId,
        currentProvider: state.currentProvider,
        currentModel: state.currentModel,
        currentModelSelectionId: state.currentModelSelectionId,
        reasoningEffort: state.reasoningEffort,
        conversationListOpen: state.conversationListOpen,
        conversationListWidth: state.conversationListWidth,
      }),
    }
  )
);
