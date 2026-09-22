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
}

export function isAgentSessionId(id: string | null | undefined): boolean {
  return !!id && id.startsWith("ses_");
}
