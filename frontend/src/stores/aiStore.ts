import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { WorkspaceContextSnapshot } from "./workspaceStore";
import { useWorkspaceStore } from "./workspaceStore";

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
  createdAt: number;
  updatedAt: number;
  context?: { type: string; label: string }[];
  contextSnapshot?: WorkspaceContextSnapshot;
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

  toggleDrawer: () => void;
  openDrawer: () => void;
  closeDrawer: () => void;
  createConversation: (provider?: string, model?: string) => string;
  setActiveConversation: (id: string) => void;
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

      toggleDrawer: () =>
        set((state) => ({ drawerOpen: !state.drawerOpen })),

      openDrawer: () => set({ drawerOpen: true }),

      closeDrawer: () => set({ drawerOpen: false }),

      createConversation: (provider, model) => {
        const id = genId("conv");
        const state = get();
        const snapshot = useWorkspaceStore.getState().getSnapshot();
        const conv: AiConversation = {
          id,
          title: "新的对话",
          messages: [],
          provider: provider || state.currentProvider,
          model: model || state.currentModel,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          contextSnapshot: snapshot,
          context: [
            { type: "workspace", label: snapshot.workspace.name },
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

      setActiveConversation: (id) => set({ activeConversationId: id }),

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
      }),
    }
  )
);
