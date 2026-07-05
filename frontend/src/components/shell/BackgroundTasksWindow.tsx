import { useCallback, useMemo } from "react";
import { useI18n } from "../../i18n";
import { SubWindow } from "../ui/window/SubWindow";
import { Button } from "../ui/primitives/Button";
import { ModuleEmptyState } from "../ui/feedback/ModuleEmptyState";
import { IconClock } from "../ui/icons/Icons";
import {
  cancelAllRunningBackgroundTasks,
  cancelBackgroundTask,
  useBackgroundTaskStore,
  useRunningBackgroundTasks,
  type BackgroundTaskInfo,
} from "../../stores/backgroundTaskStore";

function taskStatusLabel(
  t: (key: string) => string,
  status: BackgroundTaskInfo["status"],
): string {
  switch (status) {
    case "pending":
      return t("shell.backgroundTasks.statusPending");
    case "running":
      return t("shell.backgroundTasks.statusRunning");
    case "completed":
      return t("shell.backgroundTasks.statusCompleted");
    case "failed":
      return t("shell.backgroundTasks.statusFailed");
    case "cancelled":
      return t("shell.backgroundTasks.statusCancelled");
    default:
      return status;
  }
}

function taskStatusBadgeClass(status: BackgroundTaskInfo["status"]): string {
  switch (status) {
    case "pending":
    case "running":
      return "badge badge-accent";
    case "completed":
      return "badge badge-success";
    case "failed":
    case "cancelled":
      return "badge badge-danger";
    default:
      return "badge badge-muted";
  }
}

function taskModuleLabel(t: (key: string, params?: Record<string, string>) => string, module: string): string {
  const key = `shell.backgroundTasks.module.${module}`;
  const label = t(key);
  return label === key ? module : label;
}

function taskProgressPercent(task: BackgroundTaskInfo): number | null {
  if (task.rowTotal != null && task.rowTotal > 0) {
    const done = task.rowCompleted ?? 0;
    return Math.min(100, Math.max(0, Math.round((done / task.rowTotal) * 100)));
  }
  if (task.total > 0) {
    return Math.min(100, Math.max(0, Math.round((task.index / task.total) * 100)));
  }
  return null;
}

function BackgroundTaskRow({
  task,
  onCancel,
}: {
  task: BackgroundTaskInfo;
  onCancel: (id: string) => void;
}) {
  const { t } = useI18n();
  const busy = task.status === "pending" || task.status === "running";
  const progressPercent = taskProgressPercent(task);
  const showIndeterminate = busy && progressPercent == null;

  return (
    <li className={`background-tasks-row background-tasks-row--${task.status}`}>
      <div className="background-tasks-row__accent" aria-hidden />
      <div className="background-tasks-row__body">
        <div className="background-tasks-row__header">
          <div className="background-tasks-row__title" title={task.title}>
            {task.title}
          </div>
          <span className={taskStatusBadgeClass(task.status)}>
            {taskStatusLabel(t, task.status)}
          </span>
        </div>

        <div className="background-tasks-row__meta">
          <span className="background-tasks-row__module">
            {taskModuleLabel(t, task.module)}
          </span>
          {task.total > 0 ? (
            <span className="background-tasks-row__stat">
              {t("shell.backgroundTasks.progressIndex", {
                index: String(task.index),
                total: String(task.total),
              })}
            </span>
          ) : null}
          {task.rowTotal != null && task.rowTotal > 0 ? (
            <span className="background-tasks-row__stat background-tasks-row__stat--accent">
              {t("shell.backgroundTasks.rowProgress", {
                completed: String(task.rowCompleted ?? 0),
                total: String(task.rowTotal),
              })}
            </span>
          ) : null}
        </div>

        {task.progress ? (
          <p className="background-tasks-row__message">{task.progress}</p>
        ) : null}

        {busy && (progressPercent != null || showIndeterminate) ? (
          <div
            className={`background-tasks-row__bar${showIndeterminate ? " background-tasks-row__bar--indeterminate" : ""}`}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progressPercent ?? undefined}
          >
            <span
              className="background-tasks-row__bar-fill"
              style={progressPercent != null ? { width: `${progressPercent}%` } : undefined}
            />
          </div>
        ) : null}

        {task.error ? (
          <p className="background-tasks-row__error">{task.error}</p>
        ) : null}
      </div>

      {busy ? (
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="background-tasks-row__cancel"
          onClick={() => onCancel(task.id)}
        >
          {t("shell.backgroundTasks.cancel")}
        </Button>
      ) : null}
    </li>
  );
}

export function BackgroundTasksWindow() {
  const { t } = useI18n();
  const open = useBackgroundTaskStore((s) => s.taskListOpen);
  const setOpen = useBackgroundTaskStore((s) => s.setTaskListOpen);
  const tasks = useRunningBackgroundTasks();

  const summaryText = useMemo(
    () => t("shell.backgroundTasks.runningCount", { count: tasks.length }),
    [t, tasks.length],
  );

  const handleCancel = useCallback(async (id: string) => {
    try {
      await cancelBackgroundTask(id);
    } catch {
      // ignore
    }
  }, []);

  const handleCancelAll = useCallback(async () => {
    try {
      await cancelAllRunningBackgroundTasks();
    } catch {
      // ignore
    }
  }, []);

  const headerExtra =
    tasks.length > 0 ? (
      <Button type="button" variant="outline" size="xs" onClick={() => void handleCancelAll()}>
        {t("shell.backgroundTasks.cancelAll")}
      </Button>
    ) : null;

  return (
    <SubWindow
      open={open}
      title={t("shell.backgroundTasks.title")}
      onClose={() => setOpen(false)}
      widthRatio={0.52}
      heightRatio={0.48}
      className="background-tasks-window"
      headerExtra={headerExtra}
    >
      <div className="background-tasks-body">
        {tasks.length === 0 ? (
          <ModuleEmptyState
            icon={<IconClock size={36} className="module-empty-state__icon" />}
            title={t("shell.backgroundTasks.empty")}
            desc={t("shell.backgroundTasks.emptyDesc")}
            className="background-tasks-empty"
          />
        ) : (
          <>
            <div className="background-tasks-summary">
              <span className="background-tasks-summary__dot" aria-hidden />
              <span className="background-tasks-summary__text">{summaryText}</span>
            </div>
            <ul className="background-tasks-list">
              {tasks.map((task) => (
                <BackgroundTaskRow key={task.id} task={task} onCancel={handleCancel} />
              ))}
            </ul>
          </>
        )}
      </div>
    </SubWindow>
  );
}
