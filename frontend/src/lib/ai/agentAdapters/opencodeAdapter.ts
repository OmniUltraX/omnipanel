import { commands } from "../../../ipc/bindings";
import { unwrapCommand } from "../../../ipc/result";
import type {
  AgentAdapter,
  AgentChatMessage,
  AgentMessagePart,
  AgentSessionSummary,
  AgentToolCall,
  AgentToolCallStatus,
  CreateAgentSessionOptions,
  OpenCodeAgentSummary,
} from "./types";

function mapSession(row: {
  id: string;
  title: string;
  updatedAt: number;
  directory: string | null;
}): AgentSessionSummary {
  return {
    id: row.id,
    title: row.title,
    updatedAt: row.updatedAt,
    directory: row.directory,
  };
}

function mapAgent(row: {
  id: string;
  name: string;
  description: string | null;
  mode: string;
  hidden: boolean;
  color: string | null;
}): OpenCodeAgentSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    mode: row.mode,
    hidden: row.hidden,
    color: row.color,
  };
}

function normalizeToolStatus(raw: string | null | undefined): AgentToolCallStatus {
  switch ((raw ?? "").toLowerCase()) {
    case "pending":
      return "pending";
    case "running":
      return "running";
    case "failed":
    case "error":
      return "failed";
    default:
      return "completed";
  }
}

function mapOpenCodeToolCalls(
  rows:
    | {
        id: string;
        name: string;
        arguments: string;
        result: string | null;
        status: string;
      }[]
    | null
    | undefined,
): AgentToolCall[] | null {
  if (!rows?.length) return null;
  return rows.map((t) => ({
    id: t.id,
    name: t.name,
    arguments: t.arguments,
    result: t.result,
    status: normalizeToolStatus(t.status),
  }));
}

function mapOpenCodeParts(
  rows:
    | (
        | { type: "text"; text: string }
        | { type: "reasoning"; text: string }
        | {
            type: "tool-call";
            id: string;
            name: string;
            arguments: string;
            result: string | null;
            status: string;
          }
      )[]
    | null
    | undefined,
): AgentMessagePart[] | null {
  if (!rows?.length) return null;
  return rows.map((p) => {
    if (p.type === "text") return { type: "text", text: p.text };
    if (p.type === "reasoning") return { type: "reasoning", text: p.text };
    return {
      type: "tool-call",
      id: p.id,
      name: p.name,
      arguments: p.arguments,
      result: p.result,
      status: normalizeToolStatus(p.status),
    };
  });
}

export const openCodeAgentAdapter: AgentAdapter = {
  id: "opencode",
  label: "OpenCode",

  async ensureService() {
    await unwrapCommand(commands.opencodeEnsureService());
  },

  async listSessions() {
    const rows = await unwrapCommand(commands.opencodeListSessions());
    return rows.map(mapSession);
  },

  async createSession(opts?: CreateAgentSessionOptions) {
    const row = await unwrapCommand(
      commands.opencodeCreateSession(opts?.directory ?? null, opts?.model ?? null),
    );
    return mapSession(row);
  },

  async deleteSession(sessionId: string) {
    await unwrapCommand(commands.opencodeDeleteSession(sessionId));
  },

  async loadMessages(sessionId: string): Promise<AgentChatMessage[]> {
    try {
      const rows = await unwrapCommand(commands.opencodeGetMessages(sessionId), {
        // 会话已删：由上层安静回收，避免刷 console.error
        quiet: true,
      });
      return rows.map((m) => ({
        id: m.id,
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
        reasoning: m.reasoning,
        parts: mapOpenCodeParts(m.parts),
        toolCalls: mapOpenCodeToolCalls(m.toolCalls),
        createdAt: m.createdAt,
        usage: m.tokens
          ? {
              inputTokens: m.tokens.input,
              outputTokens: m.tokens.output,
              reasoningTokens: m.tokens.reasoning,
              cachedInputTokens: m.tokens.cacheRead,
              cacheWriteTokens: m.tokens.cacheWrite,
              totalTokens: m.tokens.contextTotal,
              contextLimit: m.contextLimit ?? undefined,
            }
          : null,
        providerId: m.providerId,
        modelId: m.modelId,
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/SESSION_NOT_FOUND|SessionNotFound|Session not found|404 Not Found/i.test(msg)) {
        const notFound = new Error(`SESSION_NOT_FOUND:${sessionId}`);
        (notFound as Error & { code?: string }).code = "SESSION_NOT_FOUND";
        throw notFound;
      }
      // 非预期错误补打一次日志
      console.error("[opencode] loadMessages failed:", msg);
      throw err;
    }
  },

  async listAgents() {
    const rows = await unwrapCommand(commands.opencodeListAgents());
    return rows.map(mapAgent);
  },

  async getAgent(agentId: string) {
    const row = await unwrapCommand(commands.opencodeGetAgent(agentId));
    return mapAgent(row);
  },

  async switchSessionAgent(sessionId: string, agent: string) {
    await unwrapCommand(commands.opencodeSwitchSessionAgent(sessionId, agent));
  },
};
