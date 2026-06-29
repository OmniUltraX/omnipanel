import type { McpServer } from "@agentclientprotocol/sdk";
import type { BaseMessage } from "@langchain/core/messages";

import {
  createSessionRuntime,
  disposeSessionRuntime,
  type SessionRuntime,
} from "./runtime.js";
import { runAgentTurn, type AgentStreamEvent } from "./turn.js";

export type AgentSession = SessionRuntime & {
  messages: BaseMessage[];
  activeAbort: AbortController | null;
};

/** 管理 Agent 会话生命周期与 prompt 执行（与传输协议无关）。 */
export class AgentSessionManager {
  private readonly sessions = new Map<string, AgentSession>();

  async open(sessionId: string, cwd: string, mcpServers: McpServer[] = []): Promise<AgentSession> {
    const runtime = await createSessionRuntime(sessionId, cwd, mcpServers);
    const session: AgentSession = {
      ...runtime,
      messages: [],
      activeAbort: null,
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  get(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  isRunning(sessionId: string): boolean {
    return Boolean(this.sessions.get(sessionId)?.activeAbort);
  }

  cancel(sessionId: string): void {
    this.sessions.get(sessionId)?.activeAbort?.abort();
  }

  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.activeAbort?.abort();
    await disposeSessionRuntime(session);
    this.sessions.delete(sessionId);
  }

  async prompt(
    sessionId: string,
    userText: string,
    onEvent: (event: AgentStreamEvent) => void | Promise<void>,
    options?: { signal?: AbortSignal },
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`未知 session: ${sessionId}`);
    }
    if (session.activeAbort) {
      throw new Error("上一轮仍在执行中");
    }

    const abort = new AbortController();
    session.activeAbort = abort;

    const externalSignal = options?.signal;
    const onExternalAbort = () => abort.abort();
    if (externalSignal) {
      if (externalSignal.aborted) {
        session.activeAbort = null;
        throw new DOMException("Prompt cancelled", "AbortError");
      }
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }

    try {
      await runAgentTurn(
        {
          sessionId: session.sessionId,
          messages: session.messages,
          graph: session.graph,
        },
        userText,
        { signal: abort.signal, onEvent },
      );
    } finally {
      if (externalSignal) {
        externalSignal.removeEventListener("abort", onExternalAbort);
      }
      session.activeAbort = null;
    }
  }
}
