import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useI18n } from "../../i18n";
import { MODULE_PATHS } from "../../lib/paths";
import { useAiOrchestrationStore } from "../../stores/aiOrchestrationStore";
import { followAiIntent } from "../../lib/ai/uiFollow";
import { Button } from "../ui/primitives/Button";

/** AI 侧栏：扇出任务进度（与审批队列解耦）。
 *  仅展示当前会话触发的编排任务；loop kind 的后台调度任务不在此展示，
 *  其入口归任务中心（/tasks）的"运行中"。 */
export function AiOrchestrationProgressPanel() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const tasks = useAiOrchestrationStore((s) => s.tasks);
  const cancelTask = useAiOrchestrationStore((s) => s.cancelTask);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  // 过滤：running/pending 且非 loop（loop 是后台调度，与当前对话无关）
  const running = Object.values(tasks).filter(
    (task) =>
      task.kind !== "loop" &&
      (task.status === "running" || task.status === "pending"),
  );
  const recent = Object.values(tasks)
    .filter(
      (task) =>
        task.kind !== "loop" &&
        task.status !== "running" &&
        task.status !== "pending",
    )
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
    .slice(0, 2);

  if (running.length === 0 && recent.length === 0) {
    return null;
  }

  const renderCard = (task: (typeof running)[number]) => {
    const done = task.children.filter(
      (c) =>
        c.status === "completed" || c.status === "failed" || c.status === "cancelled",
    ).length;
    const failed = task.children.filter((c) => c.status === "failed").length;
    const isCollapsed = collapsed[task.id] ?? false;
    const isFinished = task.status !== "running" && task.status !== "pending";

    return (
      <div key={task.id} className="ai-task-card">
        <button
          type="button"
          className="ai-task-card__header"
          onClick={() => setCollapsed((s) => ({ ...s, [task.id]: !isCollapsed }))}
          aria-expanded={!isCollapsed}
        >
          {isCollapsed ? (
            <ChevronRightIcon className="h-3 w-3 text-fg-2 flex-shrink-0" />
          ) : (
            <ChevronDownIcon className="h-3 w-3 text-fg-2 flex-shrink-0" />
          )}
          <strong className="truncate flex-1 text-left">{task.title}</strong>
          <span className="setting-hint flex-shrink-0">
            {t("ai.task.running", { done, total: task.children.length })}
            {failed > 0 ? ` · ${t("ai.task.failed", { count: failed })}` : ""}
          </span>
        </button>
        {!isCollapsed && (
          <>
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
              {!isFinished && (
                <Button variant="ghost" size="sm" onClick={() => cancelTask(task.id)}>
                  {t("ai.composer.buttonCancel")}
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    );
  };

  return (
    <div className="ai-task-draft-panel">
      {running.map(renderCard)}
      {recent.map(renderCard)}
    </div>
  );
}
