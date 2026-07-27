import { useNavigate } from "react-router-dom";
import { useI18n } from "../../i18n";
import { MODULE_PATHS } from "../../lib/paths";
import { useAiOrchestrationStore } from "../../stores/aiOrchestrationStore";
import { followAiIntent } from "../../lib/ai/uiFollow";
import { Button } from "../ui/primitives/Button";

/** AI 侧栏：扇出任务进度（与审批队列解耦） */
export function AiOrchestrationProgressPanel() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const tasks = useAiOrchestrationStore((s) => s.tasks);
  const cancelTask = useAiOrchestrationStore((s) => s.cancelTask);

  const running = Object.values(tasks).filter(
    (task) => task.status === "running" || task.status === "pending",
  );
  const recent = Object.values(tasks)
    .filter((task) => task.status !== "running" && task.status !== "pending")
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
    .slice(0, 2);

  if (running.length === 0 && recent.length === 0) {
    return null;
  }

  return (
    <div className="ai-task-draft-panel">
      {running.map((task) => {
        const done = task.children.filter(
          (c) =>
            c.status === "completed" || c.status === "failed" || c.status === "cancelled",
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
                          module: "terminal",
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
              <Button
                variant="ghost"
                size="sm"
                onClick={() => navigate(MODULE_PATHS.tasks)}
              >
                {t("ai.task.openPanel")}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => cancelTask(task.id)}>
                {t("ai.composer.buttonCancel")}
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
