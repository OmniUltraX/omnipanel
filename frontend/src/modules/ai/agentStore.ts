import { create } from "zustand";
import { persist } from "zustand/middleware";

// ─── Types ────────────────────────────────────────────────────

export interface AgentToolCall {
  id: string;
  name: string;
  arguments: string;
  result?: string;
  status: "pending" | "running" | "completed" | "failed";
}

export interface AgentMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp: number;
  toolCalls?: AgentToolCall[];
  isStreaming?: boolean;
}

export interface AgentConversation {
  id: string;
  title: string;
  messages: AgentMessage[];
  /** id of the AiModelConfig used */
  modelConfigId: string;
  createdAt: number;
  updatedAt: number;
}

// ─── Store ────────────────────────────────────────────────────

interface AgentState {
  conversations: AgentConversation[];
  activeId: string | null;
  isGenerating: boolean;

  // CRUD
  createConversation: (modelConfigId: string) => string;
  setActive: (id: string | null) => void;
  deleteConversation: (id: string) => void;
  renameConversation: (id: string, title: string) => void;

  // Messages
  addMessage: (
    conversationId: string,
    msg: Omit<AgentMessage, "id" | "timestamp">
  ) => string;
  updateMessage: (
    conversationId: string,
    messageId: string,
    update: Partial<AgentMessage>
  ) => void;
  appendStreamContent: (
    conversationId: string,
    messageId: string,
    delta: string
  ) => void;

  // Generating state
  setGenerating: (v: boolean) => void;

  // Helpers
  getActive: () => AgentConversation | undefined;
}

let idCounter = 0;
function genId(): string {
  return `agent_${Date.now()}_${++idCounter}`;
}

function genMsgId(): string {
  return `msg_${Date.now()}_${++idCounter}`;
}

function titleFromContent(content: string): string {
  const first = content.split("\n")[0].trim();
  return first.length > 40 ? first.slice(0, 40) + "…" : first || "新对话";
}

export const useAgentStore = create<AgentState>()(
  persist(
    (set, get) => ({
      conversations: [],
      activeId: null,
      isGenerating: false,

      createConversation: (modelConfigId) => {
        const id = genId();
        const conv: AgentConversation = {
          id,
          title: "新对话",
          messages: [],
          modelConfigId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        set((s) => ({
          conversations: [conv, ...s.conversations],
          activeId: id,
        }));
        return id;
      },

      setActive: (id) => set({ activeId: id }),

      deleteConversation: (id) =>
        set((s) => {
          const filtered = s.conversations.filter((c) => c.id !== id);
          return {
            conversations: filtered,
            activeId:
              s.activeId === id
                ? filtered[0]?.id ?? null
                : s.activeId,
          };
        }),

      renameConversation: (id, title) =>
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id === id ? { ...c, title, updatedAt: Date.now() } : c
          ),
        })),

      addMessage: (conversationId, msg) => {
        const msgId = genMsgId();
        set((s) => ({
          conversations: s.conversations.map((c) => {
            if (c.id !== conversationId) return c;
            const newMsg: AgentMessage = {
              ...msg,
              id: msgId,
              timestamp: Date.now(),
            };
            const messages = [...c.messages, newMsg];
            // Auto-title from first user message
            const title =
              c.title === "新对话" && msg.role === "user"
                ? titleFromContent(msg.content)
                : c.title;
            return { ...c, messages, title, updatedAt: Date.now() };
          }),
        }));
        return msgId;
      },

      updateMessage: (conversationId, messageId, update) =>
        set((s) => ({
          conversations: s.conversations.map((c) => {
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

      appendStreamContent: (conversationId, messageId, delta) =>
        set((s) => ({
          conversations: s.conversations.map((c) => {
            if (c.id !== conversationId) return c;
            return {
              ...c,
              messages: c.messages.map((m) =>
                m.id === messageId
                  ? { ...m, content: m.content + delta }
                  : m
              ),
            };
          }),
        })),

      setGenerating: (v) => set({ isGenerating: v }),

      getActive: () => {
        const s = get();
        return s.conversations.find((c) => c.id === s.activeId);
      },
    }),
    {
      name: "omnipanel-agent-store",
      partialize: (s) => ({
        conversations: s.conversations,
        activeId: s.activeId,
      }),
    }
  )
);
