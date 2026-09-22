import { commands } from "../../../ipc/bindings";
import { unwrapCommand } from "../../../ipc/result";
import type {
  AgentAdapter,
  AgentChatMessage,
  AgentSessionSummary,
  CreateAgentSessionOptions,
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
        createdAt: m.createdAt,
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
};
