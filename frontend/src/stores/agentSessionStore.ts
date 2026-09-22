import { create } from "zustand";

import type { AiMessage } from "./aiStore";
import type { AgentAdapter, AgentSessionSummary } from "../lib/ai/agentAdapters/types";

type AgentSessionState = {
  /** 当前适配器 id；null = 内置模式 */
  adapterId: string | null;
  sessions: AgentSessionSummary[];
  activeSessionId: string | null;
  /** 内存消息缓存，不 persist */
  messagesBySessionId: Record<string, AiMessage[]>;
  loadingList: boolean;
  loadingMessages: boolean;
  /** 正在切换到的会话 id */
  pendingSelectId: string | null;
  /** 正在删除的会话 id */
  pendingDeleteId: string | null;
  /** 正在一键清空全部会话 */
  pendingDeleteAll: boolean;
  error: string | null;

  setAdapterId: (id: string | null) => void;
  setSessions: (sessions: AgentSessionSummary[]) => void;
  setActiveSessionId: (id: string | null) => void;
  setMessages: (sessionId: string, messages: AiMessage[]) => void;
  setLoadingList: (v: boolean) => void;
  setLoadingMessages: (v: boolean) => void;
  setPendingSelectId: (id: string | null) => void;
  setPendingDeleteId: (id: string | null) => void;
  setPendingDeleteAll: (v: boolean) => void;
  setError: (error: string | null) => void;
  reset: () => void;
};

const initial = {
  adapterId: null as string | null,
  sessions: [] as AgentSessionSummary[],
  activeSessionId: null as string | null,
  messagesBySessionId: {} as Record<string, AiMessage[]>,
  loadingList: false,
  loadingMessages: false,
  pendingSelectId: null as string | null,
  pendingDeleteId: null as string | null,
  pendingDeleteAll: false,
  error: null as string | null,
};

export const useAgentSessionStore = create<AgentSessionState>((set) => ({
  ...initial,
  setAdapterId: (adapterId) => set({ adapterId }),
  setSessions: (sessions) => set({ sessions }),
  setActiveSessionId: (activeSessionId) => set({ activeSessionId }),
  setMessages: (sessionId, messages) =>
    set((s) => ({
      messagesBySessionId: { ...s.messagesBySessionId, [sessionId]: messages },
    })),
  setLoadingList: (loadingList) => set({ loadingList }),
  setLoadingMessages: (loadingMessages) => set({ loadingMessages }),
  setPendingSelectId: (pendingSelectId) => set({ pendingSelectId }),
  setPendingDeleteId: (pendingDeleteId) => set({ pendingDeleteId }),
  setPendingDeleteAll: (pendingDeleteAll) => set({ pendingDeleteAll }),
  setError: (error) => set({ error }),
  reset: () => set({ ...initial, messagesBySessionId: {} }),
}));

export function agentMessagesToAiMessages(
  rows: Awaited<ReturnType<AgentAdapter["loadMessages"]>>,
): AiMessage[] {
  return rows.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.role === "user" ? stripOmniInjectedUserPrefix(m.content) : m.content,
    reasoningContent: m.reasoning ?? undefined,
    timestamp: m.createdAt > 0 ? m.createdAt : Date.now(),
  }));
}

/**
 * 历史兼容：曾把 `[Agent]` / Skills 拼进 OpenCode user prompt。
 * 展示时只保留最后一段真实用户输入。
 */
function stripOmniInjectedUserPrefix(content: string): string {
  const text = content.trim();
  if (!text.startsWith("[Agent]") && !text.includes("## Skills")) {
    return content;
  }
  const sep = "\n\n---\n\n";
  const idx = text.lastIndexOf(sep);
  if (idx < 0) return content;
  const tail = text.slice(idx + sep.length).trim();
  return tail || content;
}

