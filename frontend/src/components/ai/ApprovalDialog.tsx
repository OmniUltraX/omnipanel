import { useEffect, useMemo } from "react";
import { Modal } from "../ui/overlay/Modal";
import { Button } from "../ui/primitives/Button";
import { useActionDraftStore } from "../../stores/actionDraftStore";
import {
  filterGlobalDialogDrafts,
  isAiAssistantSurfaceOpen,
} from "../../lib/ai/approvalSurface";
import { ApprovalActionBar } from "./ApprovalActionBar";
import { followAiIntent } from "../../lib/ai/uiFollow";
import { useAiStore } from "../../stores/aiStore";
import { useI18n } from "../../i18n";

/**
 * 全局审批弹窗：仅在侧栏未开且不能走终端 dock 时自动出现；
 * 也可由状态栏主动打开（globalDialogOpen）。
 */
export function ApprovalDialog() {
  const { t } = useI18n();
  const drafts = useActionDraftStore((s) => s.drafts);
  const focusId = useActionDraftStore((s) => s.focusId);
  const setFocusId = useActionDraftStore((s) => s.setFocusId);
  const globalDialogOpen = useActionDraftStore((s) => s.globalDialogOpen);
  const setGlobalDialogOpen = useActionDraftStore((s) => s.setGlobalDialogOpen);
  const autoDialogSuppressed = useActionDraftStore((s) => s.autoDialogSuppressed);
  const suppressAutoDialog = useActionDraftStore((s) => s.suppressAutoDialog);
  const openDrawer = useAiStore((s) => s.openDrawer);

  // 订阅侧栏开关，确保自动弹窗与内嵌条互斥
  useAiStore((s) => s.drawerOpen);

  const autoItems = useMemo(() => filterGlobalDialogDrafts(drafts), [drafts]);
  const showAuto = autoItems.length > 0 && !autoDialogSuppressed;
  const open = globalDialogOpen || showAuto;

  const list = globalDialogOpen ? drafts : autoItems;

  const current = useMemo(() => {
    if (list.length === 0) return null;
    return list.find((d) => d.id === focusId) ?? list[0];
  }, [list, focusId]);

  useEffect(() => {
    if (globalDialogOpen && drafts.length === 0) {
      setGlobalDialogOpen(false);
    }
  }, [globalDialogOpen, drafts.length, setGlobalDialogOpen]);

  useEffect(() => {
    if (current && focusId !== current.id) {
      setFocusId(current.id);
    }
  }, [current, focusId, setFocusId]);

  if (!open || !current) {
    return null;
  }

  const handleClose = () => {
    if (globalDialogOpen) setGlobalDialogOpen(false);
    else suppressAutoDialog();
  };

  const goView = () => {
    const target = current.target;
    setGlobalDialogOpen(false);
    suppressAutoDialog();

    if (target?.module === "terminal" && target.sessionId) {
      followAiIntent({
        type: "revealTerminal",
        sessionId: target.sessionId,
      });
      return;
    }

    if (
      target?.resourceId &&
      target.module &&
      target.module !== "ai" &&
      target.module !== "other"
    ) {
      followAiIntent({
        type: "openConnection",
        module: target.module === "server" ? "terminal" : target.module,
        resourceId: target.resourceId,
      });
      return;
    }

    if (!isAiAssistantSurfaceOpen()) {
      openDrawer();
    }
  };

  return (
    <Modal open onClose={handleClose}>
      <div className="approval-dialog">
        <div className="approval-dialog__header">
          <div className="approval-dialog__title">{t("ai.approval.dialogTitle")}</div>
          <div className="approval-dialog__subtitle">
            {t("ai.approval.pendingCount", { count: list.length })}
          </div>
        </div>

        <div className="approval-dialog__body">
          <ApprovalActionBar draft={current} variant="dialog" onGoView={goView} />
        </div>

        {list.length > 1 ? (
          <ul className="approval-dialog__list">
            {list.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={`approval-dialog__list-item${
                    item.id === current.id ? " is-active" : ""
                  }`}
                  onClick={() => setFocusId(item.id)}
                >
                  <span className="approval-dialog__list-title">{item.title}</span>
                  <span className="approval-dialog__list-preview">
                    {item.preview.split("\n")[0]?.slice(0, 80)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="approval-dialog__footer">
          <Button variant="secondary" size="sm" onClick={handleClose}>
            {t("common.cancel")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
