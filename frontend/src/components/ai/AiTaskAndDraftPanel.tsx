import { useI18n } from "../../i18n";
import { useActionDraftStore } from "../../stores/actionDraftStore";
import { useAiOrchestrationStore } from "../../stores/aiOrchestrationStore";
import { useBackgroundTaskStore } from "../../stores/backgroundTaskStore";
import { followAiIntent } from "../../lib/ai/uiFollow";
import { Button } from "../ui/primitives/Button";
import { showToast } from "../../stores/toastStore";

/** Dock 内：AI 扇出任务进度 + Action Draft 确认条 */
export function AiTaskAndDraftPanel() {
  const { t } = useI18n();
  const tasks = useAiOrchestrationStore((s) => s.tasks);
  const cancelTask = useAiOrchestrationStore((s) => s.cancelTask);
  const drafts = useActionDraftStore((s) => s.drafts);
  const dismiss = useActionDraftStore((s) => s.dismiss);
  const confirm = useActionDraftStore((s) => s.confirm);
  const setTaskListOpen = useBackgroundTaskStore((s) => s.setTaskListOpen);

  const running = Object.values(tasks).filter(
    (t) => t.status === "running" || t.status === "pending",
  );
  const recent = Object.values(tasks)
    .filter((t) => t.status !== "running" && t.status !== "pending")
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
    .slice(0, 2);

  if (running.length === 0 && recent.length === 0 && drafts.length === 0) {
    return null;
  }

  return (
    <div className="ai-task-draft-panel">
      {running.map((task) => {
        const done = task.children.filter(
          (c) => c.status === "completed" || c.status === "failed" || c.status === "cancelled",
        ).length;
        const failed = task.children.filter((c) => c.status === "failed").length;
        return (
          <div key={task.id} className="ai-task-card">
            <div className="ai-task-card__header">
              <strong>{task.title}</strong>
              <span className="setting-hint">
                {t("ai.task.running", { done, total: task.children.length })}
                {failed > 0 ? ` · ${t("ai.task.failed", { count: failed })}` : ""}
              </span>
            </div>
            <ul className="ai-task-card__children">
              {task.children.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    className="ai-task-child-btn"
                    onClick={() => {
                      if (c.resourceId) {
                        followAiIntent({
                          type: "openConnection",
                          module: "ssh",
                          resourceId: c.resourceId,
                        });
                      }
                    }}
                  >
                    <span>{c.title}</span>
                    <span className="setting-hint">{c.status}</span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="ai-task-card__actions">
              <Button variant="ghost" size="sm" onClick={() => setTaskListOpen(true)}>
                {t("ai.task.openPanel")}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => cancelTask(task.id)}>
                {t("ai.composer.buttonCancel")}
              </Button>
            </div>
          </div>
        );
      })}

      {drafts.map((draft) => (
        <div key={draft.id} className="ai-draft-card">
          <div className="ai-draft-card__title">{t("ai.draft.title")} · {draft.title}</div>
          <pre className="ai-draft-card__preview">{draft.preview}</pre>
          <div className="ai-task-card__actions">
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                void confirm(draft.id)
                  .then((r) => {
                    if (r) showToast(r.slice(0, 120));
                  })
                  .catch((e) => showToast(String(e)));
              }}
            >
              {t("ai.draft.confirm")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => dismiss(draft.id)}>
              {t("ai.draft.dismiss")}
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
