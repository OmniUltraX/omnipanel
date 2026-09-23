import { create } from "zustand";

import type { AiMessage } from "./aiStore";
import { normalizeAiMessage } from "./aiStore";
import type {
  AgentAdapter,
  AgentSessionSummary,
  OpenCodeAgentSummary,
} from "../lib/ai/agentAdapters/types";
import type { AiMessagePart, ToolCallState } from "../lib/ai/aiMessageParts";
import { partsFromFlatFields } from "../lib/ai/aiMessageParts";

type AgentSessionState = {
  /** 当前适配器 id；null = 内置模式 */
  adapterId: string | null;
  sessions: AgentSessionSummary[];
  activeSessionId: string | null;
  /** OpenCode `/api/agent` 列表 */
  agents: OpenCodeAgentSummary[];
  /** 当前会话选用的 OpenCode agent name（switch API 用 name） */
  activeAgentName: string | null;
  /** 按会话记住选用的 agent */
  agentBySessionId: Record<string, string>;
  loadingAgents: boolean;
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
  setAgents: (agents: OpenCodeAgentSummary[]) => void;
  setActiveAgentName: (name: string | null) => void;
  setSessionAgent: (sessionId: string, agentName: string) => void;
  setLoadingAgents: (v: boolean) => void;
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
  agents: [] as OpenCodeAgentSummary[],
  activeAgentName: null as string | null,
  agentBySessionId: {} as Record<string, string>,
  loadingAgents: false,
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
  setAgents: (agents) => set({ agents }),
  setActiveAgentName: (activeAgentName) => set({ activeAgentName }),
  setSessionAgent: (sessionId, agentName) =>
    set((s) => ({
      agentBySessionId: { ...s.agentBySessionId, [sessionId]: agentName },
      activeAgentName: s.activeSessionId === sessionId ? agentName : s.activeAgentName,
    })),
  setLoadingAgents: (loadingAgents) => set({ loadingAgents }),
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
  reset: () => set({ ...initial, messagesBySessionId: {}, agentBySessionId: {} }),
}));

export function agentMessagesToAiMessages(
  rows: Awaited<ReturnType<AgentAdapter["loadMessages"]>>,
): AiMessage[] {
  const mapped = rows.map((m) => {
    const content = m.role === "user" ? stripOmniInjectedUserPrefix(m.content) : m.content;
    const toolCalls: ToolCallState[] | undefined = m.toolCalls?.length
      ? m.toolCalls.map((t) => ({
          id: t.id,
          name: t.name,
          arguments: t.arguments,
          result: t.result ?? undefined,
          status: t.status,
        }))
      : undefined;
    const parts: AiMessagePart[] | undefined = m.parts?.length
      ? m.parts.map((p): AiMessagePart => {
          if (p.type === "text") return { type: "text", text: p.text };
          if (p.type === "reasoning") return { type: "reasoning", text: p.text };
          return {
            type: "tool-call",
            id: p.id,
            name: p.name,
            arguments: p.arguments,
            result: p.result ?? undefined,
            status: p.status,
          };
        })
      : undefined;
    return normalizeAiMessage({
      id: m.id,
      role: m.role,
      content,
      reasoningContent: m.reasoning ?? undefined,
      toolCalls,
      parts,
      timestamp: m.createdAt > 0 ? m.createdAt : Date.now(),
      usage: m.usage
        ? {
            inputTokens: m.usage.inputTokens,
            outputTokens: m.usage.outputTokens,
            reasoningTokens: m.usage.reasoningTokens,
            cachedInputTokens: m.usage.cachedInputTokens,
            cacheWriteTokens: m.usage.cacheWriteTokens,
            totalTokens: m.usage.totalTokens,
            contextLimit: m.usage.contextLimit,
          }
        : undefined,
    });
  });
  // OpenCode 多步常拆成多条 assistant；合并后 Thread 才不会在用户消息下显示「2 / 2」
  return coalesceConsecutiveAssistants(mapped);
}

/**
 * 将连续 assistant 消息合并为一条（parts 按时间拼接），消除分支选择器。
 */
export function coalesceConsecutiveAssistants(messages: AiMessage[]): AiMessage[] {
  const out: AiMessage[] = [];
  for (const msg of messages) {
    const prev = out[out.length - 1];
    if (msg.role === "assistant" && prev?.role === "assistant") {
      const mergedParts = [
        ...partsFromFlatFields(prev),
        ...partsFromFlatFields(msg),
      ];
      // 相邻同类型 text/reasoning 粘合，避免无意义碎片
      const parts: AiMessagePart[] = [];
      for (const p of mergedParts) {
        const last = parts[parts.length - 1];
        if (
          last &&
          (p.type === "text" || p.type === "reasoning") &&
          last.type === p.type
        ) {
          parts[parts.length - 1] = {
            type: p.type,
            text: last.text + p.text,
          };
        } else {
          parts.push(p);
        }
      }
      out[out.length - 1] = normalizeAiMessage({
        ...prev,
        parts,
        usage: msg.usage ?? prev.usage,
        // 保留首条 id，避免 UI 抖动；时间戳用首条
        timestamp: prev.timestamp,
      });
    } else {
      out.push(msg);
    }
  }
  return out;
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
