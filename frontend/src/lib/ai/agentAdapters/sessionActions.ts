import type { AgentAdapter } from "./types";
import { agentMessagesToAiMessages, useAgentSessionStore } from "../../../stores/agentSessionStore";
import { useAiStore } from "../../../stores/aiStore";
import { ASSISTANT_PAGE_AGENT_ID } from "../agents";

/** 刷新智能体会话列表；可选自动选中第一条。 */
export async function refreshAgentSessions(
  adapter: AgentAdapter,
  options?: { selectIfEmpty?: boolean },
): Promise<void> {
  const store = useAgentSessionStore.getState();
  store.setAdapterId(adapter.id);
  store.setLoadingList(true);
  store.setError(null);
  try {
    // 服务应在启用智能体时已拉起；此处只列会话，不再反复 ensure
    const sessions = await adapter.listSessions();
    store.setSessions(sessions);
    // 清掉 aiStore 里已不存在的 ses_ 镜像（persist 残留 / 外部删除）
    pruneMissingAgentMirrors(sessions.map((s) => s.id));

    let active = store.activeSessionId;
    if (active && !sessions.some((s) => s.id === active)) {
      active = null;
    }
    // 若当前活动仍是幽灵 ses_，也丢掉
    const aiActive = useAiStore.getState().activeConversationId;
    if (aiActive?.startsWith("ses_") && !sessions.some((s) => s.id === aiActive)) {
      active = active && sessions.some((s) => s.id === active) ? active : null;
    }
    if (!active && options?.selectIfEmpty !== false && sessions[0]) {
      active = sessions[0].id;
    }
    store.setActiveSessionId(active);
    if (active) {
      await selectAgentSession(adapter, active);
    } else {
      // 清空 aiStore 活动会话，避免残留本地会话
      useAiStore.setState((s) => ({
        activeConversationId:
          s.activeConversationId?.startsWith("ses_") ? null : s.activeConversationId,
      }));
    }
  } catch (err) {
    store.setError(err instanceof Error ? err.message : String(err));
    store.setSessions([]);
  } finally {
    store.setLoadingList(false);
  }
}

function isSessionNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code?: unknown }).code ?? "")
      : "";
  return (
    code === "SESSION_NOT_FOUND" ||
    /SESSION_NOT_FOUND|SessionNotFound|Session not found/i.test(msg)
  );
}

/** 去掉权威列表里已不存在的 ses_ 镜像。 */
function pruneMissingAgentMirrors(aliveIds: string[]): void {
  const alive = new Set(aliveIds);
  useAiStore.setState((s) => {
    const next = s.conversations.filter(
      (c) => !c.id.startsWith("ses_") || alive.has(c.id),
    );
    if (next.length === s.conversations.length) return s;
    const active =
      s.activeConversationId && next.some((c) => c.id === s.activeConversationId)
        ? s.activeConversationId
        : next.find((c) => !c.parentConversationId)?.id ?? null;
    return { conversations: next, activeConversationId: active };
  });
  const store = useAgentSessionStore.getState();
  const messagesBySessionId = Object.fromEntries(
    Object.entries(store.messagesBySessionId).filter(([id]) => alive.has(id)),
  );
  if (Object.keys(messagesBySessionId).length !== Object.keys(store.messagesBySessionId).length) {
    useAgentSessionStore.setState({ messagesBySessionId });
  }
}

/** 选中智能体会话并加载历史到 aiStore（内存镜像，不持久化 ses_）。 */
export async function selectAgentSession(
  adapter: AgentAdapter,
  sessionId: string,
): Promise<void> {
  const store = useAgentSessionStore.getState();
  if (
    store.pendingSelectId === sessionId ||
    store.pendingDeleteId ||
    store.pendingDeleteAll
  ) {
    return;
  }
  store.setActiveSessionId(sessionId);
  store.setPendingSelectId(sessionId);
  store.setLoadingMessages(true);
  store.setError(null);
  try {
    const cached = store.messagesBySessionId[sessionId];
    const rows = await adapter.loadMessages(sessionId);
    const messages = agentMessagesToAiMessages(rows);
    store.setMessages(sessionId, messages);
    mirrorSessionIntoAiStore(sessionId, messages, store.sessions);
    // 若有缓存且与权威不一致，以权威为准（上面已写）
    void cached;
  } catch (err) {
    if (isSessionNotFoundError(err)) {
      // 幽灵会话：从列表摘掉，切到下一条或清空
      const latest = useAgentSessionStore.getState();
      const nextSessions = latest.sessions.filter((s) => s.id !== sessionId);
      latest.setSessions(nextSessions);
      const messagesBySessionId = { ...latest.messagesBySessionId };
      delete messagesBySessionId[sessionId];
      useAgentSessionStore.setState({ messagesBySessionId });
      pruneMissingAgentMirrors(nextSessions.map((s) => s.id));
      latest.setError(null);
      latest.setPendingSelectId(null);
      latest.setLoadingMessages(false);
      const fallback = nextSessions[0]?.id ?? null;
      latest.setActiveSessionId(fallback);
      if (fallback && fallback !== sessionId) {
        await selectAgentSession(adapter, fallback);
      } else {
        useAiStore.setState((s) => ({
          activeConversationId: s.activeConversationId?.startsWith("ses_")
            ? null
            : s.activeConversationId,
        }));
      }
      return;
    }
    store.setError(err instanceof Error ? err.message : String(err));
  } finally {
    const latest = useAgentSessionStore.getState();
    if (latest.pendingSelectId === sessionId) {
      latest.setPendingSelectId(null);
    }
    latest.setLoadingMessages(false);
  }
}

function mirrorSessionIntoAiStore(
  sessionId: string,
  messages: ReturnType<typeof agentMessagesToAiMessages>,
  sessions: { id: string; title: string; updatedAt: number }[],
): void {
  const meta = sessions.find((s) => s.id === sessionId);
  const title = meta?.title || sessionId;
  const updatedAt = meta?.updatedAt || Date.now();
  const ai = useAiStore.getState();
  const existing = ai.conversations.find((c) => c.id === sessionId);
  if (existing) {
    useAiStore.setState((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === sessionId
          ? {
              ...c,
              title,
              messages,
              updatedAt,
              agentId: ASSISTANT_PAGE_AGENT_ID,
            }
          : c,
      ),
      activeConversationId: sessionId,
    }));
  } else {
    useAiStore.setState((s) => ({
      conversations: [
        {
          id: sessionId,
          title,
          messages,
          provider: "opencode",
          model: "",
          agentId: ASSISTANT_PAGE_AGENT_ID,
          createdAt: updatedAt,
          updatedAt,
        },
        // 去掉其它 ses_ 镜像，避免列表污染；本地会话保留
        ...s.conversations.filter((c) => !c.id.startsWith("ses_")),
      ],
      activeConversationId: sessionId,
    }));
  }
}

export async function createAgentSession(
  adapter: AgentAdapter,
  opts?: { directory?: string | null; model?: string | null },
): Promise<string> {
  const session = await adapter.createSession(opts);
  const store = useAgentSessionStore.getState();
  store.setSessions([session, ...store.sessions.filter((s) => s.id !== session.id)]);
  store.setMessages(session.id, []);
  const sessions = useAgentSessionStore.getState().sessions;
  mirrorSessionIntoAiStore(session.id, [], sessions);
  store.setActiveSessionId(session.id);
  return session.id;
}

/** 一键删除全部智能体会话；完成后可选再建一个空会话。 */
export async function deleteAllAgentSessions(
  adapter: AgentAdapter,
  opts?: { model?: string | null; createAfter?: boolean },
): Promise<void> {
  const store = useAgentSessionStore.getState();
  if (store.pendingDeleteAll || store.pendingDeleteId || store.pendingSelectId) {
    return;
  }
  const ids = store.sessions.map((s) => s.id);
  if (ids.length === 0) return;

  store.setPendingDeleteAll(true);
  store.setError(null);
  try {
    const errors: string[] = [];
    for (const id of ids) {
      try {
        await adapter.deleteSession(id);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }

    const remaining = await adapter.listSessions().catch(() => [] as typeof store.sessions);
    useAgentSessionStore.setState({
      sessions: remaining,
      messagesBySessionId: Object.fromEntries(
        Object.entries(useAgentSessionStore.getState().messagesBySessionId).filter(
          ([id]) => remaining.some((s) => s.id === id),
        ),
      ),
      activeSessionId: null,
    });
    useAiStore.setState((s) => {
      const keep = s.conversations.filter(
        (c) => !c.id.startsWith("ses_") || remaining.some((r) => r.id === c.id),
      );
      const activeStill =
        s.activeConversationId && keep.some((c) => c.id === s.activeConversationId)
          ? s.activeConversationId
          : null;
      return { conversations: keep, activeConversationId: activeStill };
    });

    if (errors.length > 0 && remaining.length > 0) {
      useAgentSessionStore.getState().setError(errors[0] ?? null);
    }

    // 先结束清空态，再新建/切换（select 与 pendingDeleteAll 互斥）
    useAgentSessionStore.getState().setPendingDeleteAll(false);

    if (opts?.createAfter !== false && remaining.length === 0) {
      await createAgentSession(adapter, { model: opts?.model ?? null });
    } else if (remaining[0]) {
      await selectAgentSession(adapter, remaining[0].id);
    } else {
      useAiStore.setState({ activeConversationId: null });
    }
  } catch (err) {
    useAgentSessionStore
      .getState()
      .setError(err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    useAgentSessionStore.getState().setPendingDeleteAll(false);
  }
}

export async function deleteAgentSession(
  adapter: AgentAdapter,
  sessionId: string,
): Promise<void> {
  const store = useAgentSessionStore.getState();
  if (store.pendingDeleteId || store.pendingSelectId || store.pendingDeleteAll) {
    return;
  }
  store.setPendingDeleteId(sessionId);
  store.setError(null);
  try {
    await adapter.deleteSession(sessionId);
    const latest = useAgentSessionStore.getState();
    const next = latest.sessions.filter((s) => s.id !== sessionId);
    latest.setSessions(next);
    const messagesBySessionId = { ...latest.messagesBySessionId };
    delete messagesBySessionId[sessionId];
    useAgentSessionStore.setState({ messagesBySessionId });

    useAiStore.setState((s) => ({
      conversations: s.conversations.filter((c) => c.id !== sessionId),
    }));

    const wasActive = latest.activeSessionId === sessionId;
    // 先清删除态，再切到下一会话（select 会互斥 pendingDeleteId）
    latest.setPendingDeleteId(null);
    if (wasActive) {
      const nextId = next[0]?.id ?? null;
      latest.setActiveSessionId(nextId);
      if (nextId) {
        await selectAgentSession(adapter, nextId);
      } else {
        useAiStore.setState({ activeConversationId: null });
      }
    }
  } catch (err) {
    useAgentSessionStore
      .getState()
      .setError(err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    const cur = useAgentSessionStore.getState();
    if (cur.pendingDeleteId === sessionId) {
      cur.setPendingDeleteId(null);
    }
  }
}

/** 离开智能体模式时清掉 ses_ 镜像与 agentSessionStore。 */
export function leaveAgentSessionMode(): void {
  useAgentSessionStore.getState().reset();
  useAiStore.setState((s) => {
    const remaining = s.conversations.filter((c) => !c.id.startsWith("ses_"));
    const active =
      s.activeConversationId && s.activeConversationId.startsWith("ses_")
        ? remaining[0]?.id ?? null
        : s.activeConversationId;
    return {
      conversations: remaining,
      activeConversationId: active,
    };
  });
}
