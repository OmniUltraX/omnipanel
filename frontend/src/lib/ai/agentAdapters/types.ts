/** 智能体会话适配器：每个 CLI 智能体一套，外壳插槽注入。 */

export type AgentSessionSummary = {
  id: string;
  title: string;
  updatedAt: number;
  directory?: string | null;
};

export type AgentToolCallStatus = "pending" | "running" | "completed" | "failed";

export type AgentToolCall = {
  id: string;
  name: string;
  arguments: string;
  result?: string | null;
  status: AgentToolCallStatus;
};

/** 有序片段（OpenCode 历史保留 tool/reasoning 交错顺序） */
export type AgentMessagePart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool-call";
      id: string;
      name: string;
      arguments: string;
      result?: string | null;
      status: AgentToolCallStatus;
    };

export type AgentChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string | null;
  parts?: AgentMessagePart[] | null;
  toolCalls?: AgentToolCall[] | null;
  createdAt: number;
  /** OpenCode assistant 消息 tokens */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
    cachedInputTokens?: number;
    cacheWriteTokens?: number;
    totalTokens?: number;
    contextLimit?: number;
  } | null;
  providerId?: string | null;
  modelId?: string | null;
};

/** OpenCode `/api/agent` 条目（下拉可选的 primary）。 */
export type OpenCodeAgentSummary = {
  id: string;
  name: string;
  description?: string | null;
  mode: string;
  hidden: boolean;
  color?: string | null;
};

export type CreateAgentSessionOptions = {
  directory?: string | null;
  /** OpenCode：`providerID/modelID` */
  model?: string | null;
};

export interface AgentAdapter {
  id: string;
  label: string;
  ensureService(): Promise<void>;
  listSessions(): Promise<AgentSessionSummary[]>;
  createSession(opts?: CreateAgentSessionOptions): Promise<AgentSessionSummary>;
  deleteSession(sessionId: string): Promise<void>;
  loadMessages(sessionId: string): Promise<AgentChatMessage[]>;
  listAgents(): Promise<OpenCodeAgentSummary[]>;
  getAgent(agentId: string): Promise<OpenCodeAgentSummary>;
  switchSessionAgent(sessionId: string, agent: string): Promise<void>;
}

export function isAgentSessionId(id: string | null | undefined): boolean {
  return !!id && id.startsWith("ses_");
}

/** 下拉可见：非 hidden 且 mode 为 primary / all（缺省 mode 视为可选）。 */
export function isSelectableOpenCodeAgent(agent: OpenCodeAgentSummary): boolean {
  if (agent.hidden) return false;
  const mode = String(agent.mode ?? "all").trim().toLowerCase();
  if (!mode) return true;
  return mode === "primary" || mode === "all";
}
