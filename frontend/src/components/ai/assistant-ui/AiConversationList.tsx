import { useCallback, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { appConfirm } from "../../../lib/appConfirm";
import { useI18n } from "../../../i18n";
import {
  useActiveAgentAdapter,
} from "../../../lib/ai/agentAdapters";
import {
  createAgentSession,
  deleteAgentSession,
  deleteAllAgentSessions,
  selectAgentSession,
} from "../../../lib/ai/agentAdapters/sessionActions";
import { parseOpenCodeBackendId } from "../../../lib/ai/inferenceBackend";
import { useAgentSessionStore } from "../../../stores/agentSessionStore";
import { useAiStore } from "../../../stores/aiStore";
import { useWorkspaceStore } from "../../../stores/workspaceStore";
import { Button } from "../../ui/primitives/Button";
import { IconPlus, IconTrash, IconXCircle } from "../../ui/icons/Icons";

function formatConversationTime(ts: number, t: (key: string, params?: Record<string, string | number>) => string): string {
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return t("knowledge.time.justNow");
  if (minutes < 60) return t("knowledge.time.minutesAgo", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("knowledge.time.hoursAgo", { n: hours });
  const days = Math.floor(hours / 24);
  return t("knowledge.time.daysAgo", { n: days });
}

function resolveOpenCodeModelKey(): string | null {
  const selection =
    useAiStore.getState().currentModelSelectionId ||
    useAiStore.getState().conversations.find(
      (c) => c.id === useAiStore.getState().activeConversationId,
    )?.modelSelectionId ||
    null;
  if (!selection) return null;
  const parsed = parseOpenCodeBackendId(selection);
  if (!parsed) return null;
  return `${parsed.providerId}/${parsed.modelId}`;
}

function SessionRowSpinner({ label }: { label: string }) {
  return (
    <span className="ai-session-row-spinner" aria-label={label} title={label}>
      <span className="ai-session-row-spinner__dot" aria-hidden />
    </span>
  );
}

/** 会话列表面板（右侧栏或下拉内嵌） */
export function AiConversationList({
  compact = false,
  showCreateButton = true,
  onItemActivate,
}: {
  compact?: boolean;
  /** 外层已有「新建」时关掉，避免重复入口 */
  showCreateButton?: boolean;
  onItemActivate?: () => void;
} = {}) {
  const { t } = useI18n();
  const adapter = useActiveAgentAdapter();
  const agentSessions = useAgentSessionStore((s) => s.sessions);
  const agentActiveId = useAgentSessionStore((s) => s.activeSessionId);
  const agentLoading = useAgentSessionStore((s) => s.loadingList);
  const agentError = useAgentSessionStore((s) => s.error);
  const pendingSelectId = useAgentSessionStore((s) => s.pendingSelectId);
  const pendingDeleteId = useAgentSessionStore((s) => s.pendingDeleteId);
  const pendingDeleteAll = useAgentSessionStore((s) => s.pendingDeleteAll);
  const loadingMessages = useAgentSessionStore((s) => s.loadingMessages);

  // 内置会话：本地短暂 busy（无 IPC）
  const [localBusy, setLocalBusy] = useState<{
    id: string;
    kind: "select" | "delete" | "deleteAll";
  } | null>(null);

  // 只展示根会话；子会话不在列表中显示，只能从父会话 cluster 卡片进入
  // useShallow：filter 每次返回新数组引用，需浅比较内容避免 useSyncExternalStore 无限循环
  const conversations = useAiStore(
    useShallow((s) => s.conversations.filter((c) => !c.parentConversationId)),
  );
  const activeConversationId = useAiStore((s) => s.activeConversationId);
  const isGenerating = useAiStore((s) => s.isGenerating);
  const createConversation = useAiStore((s) => s.createConversation);
  const setActiveConversation = useAiStore((s) => s.setActiveConversation);
  const deleteConversationCascade = useAiStore((s) => s.deleteConversationCascade);
  const workspaces = useWorkspaceStore((s) => s.workspaces);

  const selectBusyId = adapter
    ? pendingSelectId
    : localBusy?.kind === "select"
      ? localBusy.id
      : null;
  const deleteBusyId = adapter
    ? pendingDeleteId
    : localBusy?.kind === "delete"
      ? localBusy.id
      : null;
  const deletingAll = adapter
    ? pendingDeleteAll
    : localBusy?.kind === "deleteAll";
  const listBusy = Boolean(
    selectBusyId ||
      deleteBusyId ||
      deletingAll ||
      (adapter && (agentLoading || loadingMessages)),
  );

  const handleCreate = useCallback(() => {
    if (listBusy || isGenerating) return;
    if (adapter) {
      void createAgentSession(adapter, {
        model: resolveOpenCodeModelKey(),
      }).then(() => onItemActivate?.());
      return;
    }
    createConversation();
    onItemActivate?.();
  }, [adapter, createConversation, isGenerating, listBusy, onItemActivate]);

  const handleDeleteAll = useCallback(async () => {
    if (isGenerating || listBusy) return;
    const count = adapter ? agentSessions.length : conversations.length;
    if (count === 0) return;
    if (!(await appConfirm(t("ai.conversations.deleteAllConfirm", { n: count })))) {
      return;
    }
    if (adapter) {
      try {
        await deleteAllAgentSessions(adapter, {
          model: resolveOpenCodeModelKey(),
          createAfter: true,
        });
      } catch {
        // error 已写入 agentSessionStore
      }
      return;
    }
    setLocalBusy({ id: "*", kind: "deleteAll" });
    try {
      await Promise.resolve();
      const ids = conversations.map((c) => c.id);
      for (const id of ids) {
        deleteConversationCascade(id);
      }
      createConversation();
    } finally {
      setLocalBusy(null);
    }
  }, [
    adapter,
    agentSessions.length,
    conversations,
    createConversation,
    deleteConversationCascade,
    isGenerating,
    listBusy,
    t,
  ]);

  const handleDelete = useCallback(
    async (id: string, e: React.MouseEvent) => {
      e.stopPropagation();
      if (isGenerating || listBusy) return;
      if (!(await appConfirm(t("ai.conversations.deleteConfirm")))) return;
      if (adapter) {
        try {
          await deleteAgentSession(adapter, id);
        } catch {
          // error 已写入 agentSessionStore
        }
        return;
      }
      setLocalBusy({ id, kind: "delete" });
      try {
        // 让出一帧以渲染 loading
        await Promise.resolve();
        deleteConversationCascade(id);
      } finally {
        setLocalBusy(null);
      }
    },
    [adapter, deleteConversationCascade, isGenerating, listBusy, t],
  );

  const handleSelect = useCallback(
    (id: string) => {
      if (isGenerating || listBusy) return;
      if (adapter) {
        if (id === agentActiveId && !loadingMessages) {
          onItemActivate?.();
          return;
        }
        void selectAgentSession(adapter, id).then(() => onItemActivate?.());
        return;
      }
      if (id === activeConversationId) {
        onItemActivate?.();
        return;
      }
      setLocalBusy({ id, kind: "select" });
      // 同步切换也给一帧 loading，避免无反馈
      requestAnimationFrame(() => {
        setActiveConversation(id);
        setLocalBusy(null);
        onItemActivate?.();
      });
    },
    [
      activeConversationId,
      adapter,
      agentActiveId,
      isGenerating,
      listBusy,
      loadingMessages,
      onItemActivate,
      setActiveConversation,
    ],
  );

  const rows = adapter
    ? agentSessions.map((s) => ({
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
        pinnedWorkspaceId: null as string | null,
        linkedTerminalSessionId: null as string | null,
      }))
    : conversations.map((c) => ({
        id: c.id,
        title: c.title,
        updatedAt: c.updatedAt,
        pinnedWorkspaceId: c.pinnedWorkspaceId ?? null,
        linkedTerminalSessionId: c.linkedTerminalSessionId ?? null,
      }));

  const activeId = adapter ? agentActiveId : activeConversationId;

  return (
    <div className={`ai-session-list-inner${compact ? " ai-session-list-inner--compact" : ""}`}>
      <div className="ai-session-list-header">
        <span className="ai-session-list-title">{t("ai.conversations.listTitle")}</span>
        <div className="ai-session-list-header-actions">
          {rows.length > 0 ? (
            <Button
              variant="ghost"
              size="icon-xs"
              className="ai-session-list-clear"
              onClick={() => void handleDeleteAll()}
              disabled={isGenerating || listBusy}
              aria-label={t("ai.conversations.deleteAll")}
              title={t("ai.conversations.deleteAll")}
            >
              {deletingAll ? (
                <SessionRowSpinner label={t("ai.conversations.deletingAll")} />
              ) : (
                <IconTrash size={14} />
              )}
            </Button>
          ) : null}
          {showCreateButton ? (
            <Button
              variant="ghost"
              size="icon-xs"
              className="ai-session-list-add"
              onClick={handleCreate}
              disabled={isGenerating || listBusy}
              aria-label={t("ai.conversations.new")}
              title={t("ai.conversations.new")}
            >
              <IconPlus size={14} />
            </Button>
          ) : null}
        </div>
      </div>
      <div className={`ai-session-list-body${listBusy ? " is-busy" : ""}`}>
        {adapter && agentError ? (
          <div className="ai-session-list-empty">{agentError}</div>
        ) : rows.length === 0 ? (
          <div className="ai-session-list-empty">
            {adapter && agentLoading
              ? t("ai.conversations.loading")
              : t("ai.conversations.empty")}
          </div>
        ) : (
          rows.map((conv) => {
            const active = conv.id === activeId;
            const selecting = selectBusyId === conv.id;
            const deleting = deleteBusyId === conv.id;
            const rowBusy = selecting || deleting || Boolean(deletingAll);
            return (
              <button
                key={conv.id}
                type="button"
                className={`ai-session-row${active ? " active" : ""}${rowBusy ? " is-busy" : ""}${
                  listBusy && !rowBusy ? " is-dimmed" : ""
                }${deletingAll ? " is-dimmed" : ""}`}
                onClick={() => handleSelect(conv.id)}
                disabled={listBusy}
                aria-busy={rowBusy || undefined}
              >
                <div className="ai-session-row-main">
                  <div className="ai-session-row-title">{conv.title}</div>
                  <div className="ai-session-row-meta">
                    {conv.pinnedWorkspaceId ? (
                      <span className="ai-session-row-workspace">
                        {workspaces.find((w) => w.id === conv.pinnedWorkspaceId)?.name ??
                          conv.pinnedWorkspaceId}
                      </span>
                    ) : null}
                    {conv.pinnedWorkspaceId ? <span className="ai-session-row-dot">·</span> : null}
                    {conv.linkedTerminalSessionId ? (
                      <span className="ai-session-row-workspace">term</span>
                    ) : null}
                    {conv.linkedTerminalSessionId ? (
                      <span className="ai-session-row-dot">·</span>
                    ) : null}
                    <span>
                      {deletingAll
                        ? t("ai.conversations.deletingAll")
                        : deleting
                          ? t("ai.conversations.deleting")
                          : selecting
                            ? t("ai.conversations.switching")
                            : formatConversationTime(conv.updatedAt, t)}
                    </span>
                  </div>
                </div>
                {rowBusy && !deletingAll ? (
                  <SessionRowSpinner
                    label={
                      deleting
                        ? t("ai.conversations.deleting")
                        : t("ai.conversations.switching")
                    }
                  />
                ) : deletingAll ? null : (
                  <span
                    role="button"
                    tabIndex={0}
                    className={`ai-session-row-delete${isGenerating || listBusy ? " disabled" : ""}`}
                    onClick={(e) => void handleDelete(conv.id, e)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.stopPropagation();
                        void handleDelete(conv.id, e as unknown as React.MouseEvent);
                      }
                    }}
                    aria-label={t("ai.conversations.delete")}
                    title={t("ai.conversations.delete")}
                  >
                    <IconXCircle size={14} />
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
