/** 智能体会话适配器：每个 CLI 智能体一套，外壳插槽注入。 */

export type AgentSessionSummary = {
  id: string;
  title: string;
  updatedAt: number;
  directory?: string | null;
};

export type AgentChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string | null;
  createdAt: number;
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

/** 下拉可见：非 hidden 且 mode 为 primary / all。 */
export function isSelectableOpenCodeAgent(agent: OpenCodeAgentSummary): boolean {
  if (agent.hidden) return false;
  const mode = agent.mode.toLowerCase();
  return mode === "primary" || mode === "all";
}
