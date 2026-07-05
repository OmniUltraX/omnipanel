import { useCallback } from "react";

import { appConfirm } from "../../../lib/appConfirm";
import { useI18n } from "../../../i18n";
import { useAiStore } from "../../../stores/aiStore";
import { Button } from "../../ui/primitives/Button";
import { IconPlus, IconXCircle } from "../../ui/icons/Icons";

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

/** 右侧会话列表面板 */
export function AiConversationList() {
  const { t } = useI18n();
  const conversations = useAiStore((s) => s.conversations);
  const activeConversationId = useAiStore((s) => s.activeConversationId);
  const isGenerating = useAiStore((s) => s.isGenerating);
  const createConversation = useAiStore((s) => s.createConversation);
  const setActiveConversation = useAiStore((s) => s.setActiveConversation);
  const deleteConversation = useAiStore((s) => s.deleteConversation);

  const handleCreate = useCallback(() => {
    createConversation();
  }, [createConversation]);

  const handleDelete = useCallback(
    async (id: string, e: React.MouseEvent) => {
      e.stopPropagation();
      if (isGenerating) return;
      if (!(await appConfirm(t("ai.conversations.deleteConfirm")))) return;
      deleteConversation(id);
    },
    [deleteConversation, isGenerating, t],
  );

  return (
    <>
      <div className="ai-session-list-header">
        <span className="ai-session-list-title">{t("ai.conversations.listTitle")}</span>
        <Button
          variant="ghost"
          size="icon-xs"
          className="ai-session-list-add"
          onClick={handleCreate}
          disabled={isGenerating}
          aria-label={t("ai.conversations.new")}
          title={t("ai.conversations.new")}
        >
          <IconPlus size={14} />
        </Button>
      </div>
      <div className="ai-session-list-body">
        {conversations.length === 0 ? (
          <div className="ai-session-list-empty">{t("ai.conversations.empty")}</div>
        ) : (
          conversations.map((conv) => {
            const active = conv.id === activeConversationId;
            const workspaceLabel = conv.contextSnapshot?.workspace.name ?? conv.context?.[0]?.label;
            return (
              <button
                key={conv.id}
                type="button"
                className={`ai-session-row${active ? " active" : ""}`}
                onClick={() => setActiveConversation(conv.id)}
              >
                <div className="ai-session-row-main">
                  <div className="ai-session-row-title">{conv.title}</div>
                  <div className="ai-session-row-meta">
                    {workspaceLabel ? (
                      <span className="ai-session-row-workspace">{workspaceLabel}</span>
                    ) : null}
                    {workspaceLabel ? <span className="ai-session-row-dot">·</span> : null}
                    <span>{formatConversationTime(conv.updatedAt, t)}</span>
                  </div>
                </div>
                <span
                  role="button"
                  tabIndex={0}
                  className={`ai-session-row-delete${isGenerating ? " disabled" : ""}`}
                  onClick={(e) => void handleDelete(conv.id, e)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.stopPropagation();
                      handleDelete(conv.id, e as unknown as React.MouseEvent);
                    }
                  }}
                  aria-label={t("ai.conversations.delete")}
                  title={t("ai.conversations.delete")}
                >
                  <IconXCircle size={14} />
                </span>
              </button>
            );
          })
        )}
      </div>
    </>
  );
}
