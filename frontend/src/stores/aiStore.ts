import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface ToolCallState {
  id: string;
  name: string;
  arguments: string;
  result?: string;
  status: "pending" | "running" | "completed" | "failed";
}

export interface AiMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp: number;
  toolCalls?: ToolCallState[];
  isStreaming?: boolean;
}

export interface AiConversation {
  id: string;
  title: string;
  messages: AiMessage[];
  provider: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  context?: { type: string; label: string }[];
}

interface AiStore {
  conversations: AiConversation[];
  activeConversationId: string | null;
  drawerOpen: boolean;
  drawerMode: "drawer" | "pinned";
  currentProvider: string;
  currentModel: string;
  isGenerating: boolean;

  toggleDrawer: () => void;
  openDrawer: () => void;
  closeDrawer: () => void;
  setDrawerMode: (mode: "drawer" | "pinned") => void;
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
  setCurrentProvider: (provider: string, model: string) => void;
  setIsGenerating: (v: boolean) => void;
  setContext: (conversationId: string, context: { type: string; label: string }[]) => void;
  addContext: (conversationId: string, chip: { type: string; label: string }) => void;
  removeContext: (conversationId: string, type: string) => void;
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
      drawerMode: "drawer",
      currentProvider: "openai",
      currentModel: "gpt-4o",
      isGenerating: false,

      toggleDrawer: () =>
        set((state) => ({ drawerOpen: !state.drawerOpen })),

      openDrawer: () => set({ drawerOpen: true }),

      closeDrawer: () => set({ drawerOpen: false }),

      setDrawerMode: (mode) => set({ drawerMode: mode }),

      createConversation: (provider, model) => {
        const id = genId("conv");
        const state = get();
        const conv: AiConversation = {
          id,
          title: "New Conversation",
          messages: [],
          provider: provider || state.currentProvider,
          model: model || state.currentModel,
          createdAt: Date.now(),
          updatedAt: Date.now(),
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
              c.title === "New Conversation" && msg.role === "user"
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
                  ? { ...m, content: m.content + chunk }
                  : m
              ),
            };
          }),
        })),

      setCurrentProvider: (provider, model) =>
        set({ currentProvider: provider, currentModel: model }),

      setIsGenerating: (v) => set({ isGenerating: v }),

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
            if (existing.some((ch) => ch.type === chip.type)) return c;
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
    }),
    {
      name: "omnipanel-ai-store",
      partialize: (state) => ({
        conversations: state.conversations,
        activeConversationId: state.activeConversationId,
        currentProvider: state.currentProvider,
        currentModel: state.currentModel,
        drawerMode: state.drawerMode,
      }),
    }
  )
);
