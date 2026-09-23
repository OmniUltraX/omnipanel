import type { AgentAdapter } from "./types";
import { isSelectableOpenCodeAgent } from "./types";
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
    // 并行：会话列表 + Agent 列表
    const [sessions] = await Promise.all([
      adapter.listSessions(),
      refreshOpenCodeAgents(adapter),
    ]);
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
    // 保留已有列表：拉列表失败时不要 setSessions([])，否则右侧「暂无会话」
    // 而中间 aiStore 镜像仍在，形成「幽灵对话」。
  } finally {
    store.setLoadingList(false);
  }
}

/** OmniPanel 写入的 OpenCode 运维智能体 id（与后端 OPS_AGENT_ID 一致）。 */
export const OPENCODE_OPS_AGENT_ID = "omnipanel-ops";

/** 拉取并写入 OpenCode Agent 列表；优先选中运维智能体，否则第一个可切换 primary。 */
export async function refreshOpenCodeAgents(adapter: AgentAdapter): Promise<void> {
  const store = useAgentSessionStore.getState();
  store.setLoadingAgents(true);
  try {
    const agents = await adapter.listAgents();
    store.setAgents(agents);
    const selectable = agents.filter(isSelectableOpenCodeAgent);
    const current = store.activeAgentName;
    const ops = selectable.find(
      (a) => a.id === OPENCODE_OPS_AGENT_ID || a.name === OPENCODE_OPS_AGENT_ID,
    );
    if (!current || !selectable.some((a) => a.name === current || a.id === current)) {
      // 必须用 id：OpenCode session.agent / 执行查找都认 id（build），不认显示名（Build）
      const fallback = ops?.id ?? selectable[0]?.id ?? null;
      store.setActiveAgentName(fallback);
    } else if (selectable.some((a) => a.name === current && a.id !== current)) {
      // 本地曾存显示名：校正为 id
      const hit = selectable.find((a) => a.name === current);
      if (hit) store.setActiveAgentName(hit.id);
    }
  } catch (err) {
    // 保留已有列表，避免瞬时失败把下拉清空成「没数据」
    store.setError(err instanceof Error ? err.message : String(err));
  } finally {
    store.setLoadingAgents(false);
  }
}

/** 切换当前会话的 OpenCode Agent（写远端 + 本地记忆）。 */
export async function switchOpenCodeSessionAgent(
  adapter: AgentAdapter,
  sessionId: string,
  agentName: string,
): Promise<void> {
  await adapter.switchSessionAgent(sessionId, agentName);
  useAgentSessionStore.getState().setSessionAgent(sessionId, agentName);
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

/** OpenCode 默认占位标题（尚未 LLM 生成）。 */
export function isDefaultOpenCodeTitle(title: string, sessionId?: string): boolean {
  const t = title.trim();
  if (!t) return true;
  if (sessionId && t === sessionId) return true;
  return (
    t.startsWith("New session - ") ||
    t.startsWith("Child session - ") ||
    /^ses_[A-Za-z0-9]+$/.test(t)
  );
}

/** 把权威会话标题同步进 aiStore 镜像（不碰消息）。 */
function syncSessionTitlesIntoAiStore(
  sessions: { id: string; title: string; updatedAt: number }[],
): void {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  useAiStore.setState((s) => {
    let changed = false;
    const conversations = s.conversations.map((c) => {
      if (!c.id.startsWith("ses_")) return c;
      const meta = byId.get(c.id);
      if (!meta) return c;
      if (c.title === meta.title && c.updatedAt === meta.updatedAt) return c;
      changed = true;
      return { ...c, title: meta.title, updatedAt: meta.updatedAt };
    });
    return changed ? { conversations } : s;
  });
}

/**
 * 仅刷新会话列表元数据（标题 / 更新时间），不切换活动会话、不重拉消息。
 * OpenCode 会在首轮对话后异步生成标题，需在回合结束后调用。
 */
export async function refreshAgentSessionMeta(adapter: AgentAdapter): Promise<void> {
  try {
    const remote = await adapter.listSessions();
    const store = useAgentSessionStore.getState();
    const prev = store.sessions;

    // 元数据刷新拿到空列表、但本地仍有会话：多为瞬时空响应 / 解析抖动，
    // 若直接 setSessions([]) 会清空右侧栏，留下中间聊天镜像的「幽灵对话」。
    if (remote.length === 0 && prev.length > 0) {
      return;
    }

    // 远端为准更新标题；保留「刚创建、远端列表尚未出现」的活动会话，避免竞态抹掉。
    const byId = new Map(remote.map((s) => [s.id, s]));
    const activeId = store.activeSessionId;
    for (const old of prev) {
      if (byId.has(old.id)) continue;
      const keep =
        old.id === activeId ||
        Boolean(store.messagesBySessionId[old.id]?.length);
      if (keep) byId.set(old.id, old);
    }
    const merged = Array.from(byId.values()).sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
    store.setSessions(merged);
    syncSessionTitlesIntoAiStore(remote);
  } catch {
    // 标题刷新失败静默；列表仍可用旧数据
  }
}

const titleRefreshTimers = new Map<string, ReturnType<typeof setTimeout>[]>();

/**
 * 回合结束后多次拉取标题：OpenCode 的 ensureTitle 是异步 fork，首轮结束后可能尚未写回。
 */
export function scheduleOpenCodeTitleRefresh(
  adapter: AgentAdapter,
  sessionId: string,
): void {
  const prev = titleRefreshTimers.get(sessionId);
  if (prev) {
    for (const t of prev) clearTimeout(t);
  }
  const delays = [600, 2200, 5500];
  const timers: ReturnType<typeof setTimeout>[] = [];
  for (const ms of delays) {
    timers.push(
      setTimeout(() => {
        void refreshAgentSessionMeta(adapter).then(() => {
          const row = useAgentSessionStore
            .getState()
            .sessions.find((s) => s.id === sessionId);
          if (row && !isDefaultOpenCodeTitle(row.title, sessionId)) {
            const left = titleRefreshTimers.get(sessionId);
            if (left) {
              for (const t of left) clearTimeout(t);
              titleRefreshTimers.delete(sessionId);
            }
          }
        });
      }, ms),
    );
  }
  titleRefreshTimers.set(sessionId, timers);
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
  // 恢复该会话选中的 OpenCode Agent（Tab 语义；存/切均用 id）
  {
    const selectable = store.agents.filter(isSelectableOpenCodeAgent);
    const remembered = store.agentBySessionId[sessionId];
    const resolveId = (raw: string | null | undefined) => {
      if (!raw) return null;
      const hit = selectable.find((a) => a.id === raw || a.name === raw);
      return hit?.id ?? null;
    };
    const nextAgent =
      resolveId(remembered) ||
      resolveId(store.activeAgentName) ||
      selectable[0]?.id ||
      null;
    if (nextAgent) {
      store.setActiveAgentName(nextAgent);
    }
  }
  try {
    // 先刷列表标题，再拉消息，避免镜像沿用旧 title / ses_ id
    await refreshAgentSessionMeta(adapter);
    const latestSessions = useAgentSessionStore.getState().sessions;
    const cached = useAgentSessionStore.getState().messagesBySessionId[sessionId];
    const rows = await adapter.loadMessages(sessionId);
    const messages = agentMessagesToAiMessages(rows);
    let modelKey: string | null = null;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i];
      if (row.role === "assistant" && row.providerId && row.modelId) {
        modelKey = `${row.providerId}/${row.modelId}`;
        break;
      }
    }
    useAgentSessionStore.getState().setMessages(sessionId, messages);
    mirrorSessionIntoAiStore(sessionId, messages, latestSessions, modelKey);
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
  modelKey?: string | null,
): void {
  const meta = sessions.find((s) => s.id === sessionId);
  const title = meta?.title || sessionId;
  const updatedAt = meta?.updatedAt || Date.now();
  const model = (modelKey ?? "").trim();
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
              ...(model ? { model } : {}),
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
          model,
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
  const agentName = store.activeAgentName;
  if (agentName) {
    try {
      await adapter.switchSessionAgent(session.id, agentName);
      store.setSessionAgent(session.id, agentName);
    } catch {
      // 新建后切 agent 失败不阻断；下次发送前可再切
    }
  }
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
