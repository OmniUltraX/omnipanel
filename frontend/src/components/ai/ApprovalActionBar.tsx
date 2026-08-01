import { useEffect, useRef } from "react";
import {
  getDraftActions,
  useActionDraftStore,
  type ActionDraft,
} from "../../stores/actionDraftStore";
import {
  addPermanentCommandWhitelist,
  addSessionCommandWhitelist,
  formatCommandWhitelistLabel,
} from "../../modules/terminal/terminalCommandWhitelist";
import { showToast } from "../../stores/toastStore";
import { useI18n } from "../../i18n";

type ApprovalActionBarProps = {
  draft: ActionDraft;
  /** dock = 侧栏/终端风格内嵌；dialog = 全局弹窗主区 */
  variant?: "dock" | "dialog";
  showMoreHint?: boolean;
  moreCount?: number;
  onFocusNext?: () => void;
  onGoView?: () => void;
};

export function ApprovalActionBar({
  draft,
  variant = "dock",
  showMoreHint = false,
  moreCount = 0,
  onFocusNext,
  onGoView,
}: ApprovalActionBarProps) {
  const { t } = useI18n();
  const resolveAction = useActionDraftStore((s) => s.resolveAction);
  const barRef = useRef<HTMLDivElement>(null);
  const actions = getDraftActions(draft);
  const isDock = variant === "dock";
  const risk = draft.risk;
  const needsConfirm = risk === "high" || risk === "critical";

  useEffect(() => {
    if (!isDock) return;
    barRef.current?.focus();
  }, [draft.id, isDock]);

  const isTerminalDraft = draft.kind === "terminal" || draft.kind === "shell";

  const run = (actionId: string) => {
    void resolveAction(draft.id, actionId)
      .then((r) => {
        // 门闩确认仅返回 "approved"，无需 toast；真实工具输出再提示
        if (r && r !== "approved" && r !== "allowed" && r !== "confirmed") {
          showToast(r.slice(0, 120));
        }
      })
      .catch((e) => showToast(String(e)));
  };

  const whitelistCmdLabel = formatCommandWhitelistLabel(draft.preview);
  const whitelistScope = {
    conversationId: draft.conversationId ?? draft.target?.conversationId,
    terminalSessionId: draft.target?.sessionId,
  };

  const runWithWhitelist = (scope: "session" | "permanent") => {
    const command = draft.preview.trim();
    if (!command) {
      run("confirm");
      return;
    }
    const label = formatCommandWhitelistLabel(command);
    const keys =
      scope === "permanent"
        ? addPermanentCommandWhitelist(command)
        : addSessionCommandWhitelist(command, whitelistScope);
    if (keys.length > 0) {
      showToast(
        scope === "permanent"
          ? t("ai.approval.whitelistPermanentToast", { cmd: label })
          : t("ai.approval.whitelistSessionToast", { cmd: label }),
      );
    }
    run("confirm");
  };

  return (
    <div
      ref={barRef}
      className={`approval-action-bar approval-action-bar--${variant}${
        isDock ? " term-warp-toolcall term-warp-toolcall--pending term-warp-toolcall--dock" : ""
      }`}
      tabIndex={isDock ? 0 : -1}
      data-approval-id={draft.id}
    >
      <div className={isDock ? "term-warp-toolcall__row" : "approval-action-bar__row"}>
        <span className={isDock ? "term-warp-toolcall__label" : "approval-action-bar__label"}>
          {draft.title || t("ai.approval.label")}
        </span>
        <button
          type="button"
          className={isDock ? "term-warp-toolcall__command" : "approval-action-bar__preview"}
          title={draft.preview}
        >
          {draft.preview.split("\n")[0]?.slice(0, 120) || draft.title}
        </button>
        {showMoreHint && moreCount > 0 ? (
          <button
            type="button"
            className="approval-action-bar__more"
            onClick={onFocusNext}
          >
            {t("ai.approval.more", { count: moreCount })}
          </button>
        ) : null}
        <div className={isDock ? "term-warp-toolcall__actions" : "approval-action-bar__actions"}>
          {actions.map((action) => {
            const isReject =
              !!action.reject ||
              action.variant === "danger" ||
              /reject|deny|cancel/i.test(action.id);
            return (
              <button
                key={action.id}
                type="button"
                className={
                  isReject
                    ? "term-warp-toolcall__reject"
                    : action.variant === "secondary"
                      ? "term-warp-toolcall__edit-btn"
                      : "term-warp-toolcall__run"
                }
                onClick={() => run(action.id)}
              >
                {action.label}
              </button>
            );
          })}
          {isTerminalDraft ? (
            <>
              <button
                type="button"
                className="term-warp-toolcall__edit-btn"
                title={t("ai.approval.whitelistPermanentDesc", { cmd: whitelistCmdLabel })}
                onClick={() => runWithWhitelist("permanent")}
              >
                {t("ai.approval.whitelistPermanent", { cmd: whitelistCmdLabel })}
              </button>
              <button
                type="button"
                className="term-warp-toolcall__edit-btn"
                title={t("ai.approval.whitelistSessionDesc", { cmd: whitelistCmdLabel })}
                onClick={() => runWithWhitelist("session")}
              >
                {t("ai.approval.whitelistSession", { cmd: whitelistCmdLabel })}
              </button>
            </>
          ) : null}
          {onGoView ? (
            <button
              type="button"
              className="term-warp-toolcall__edit-btn"
              onClick={onGoView}
            >
              {t("ai.approval.goView")}
            </button>
          ) : null}
        </div>
      </div>
      {needsConfirm ? (
        <p className={isDock ? "term-warp-toolcall__risk" : "approval-action-bar__risk"}>
          {t("ai.approval.highRiskHint")}
        </p>
      ) : null}
      {variant === "dialog" && draft.preview.includes("\n") ? (
        <pre className="approval-action-bar__preview-full">{draft.preview}</pre>
      ) : null}
    </div>
  );
}
