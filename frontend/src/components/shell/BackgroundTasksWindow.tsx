import { useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useI18n } from "../../i18n";
import { MODULE_PATHS } from "../../lib/paths";
import { SubWindow } from "../ui/window/SubWindow";
import { Button } from "../ui/primitives/Button";
import { ModuleEmptyState } from "../ui/feedback/ModuleEmptyState";
import { IconClock, IconClose, IconCopy } from "../ui/icons/Icons";
import { showToast } from "../../stores/toastStore";
import { useFileManagerStore } from "../../stores/fileManagerStore";
import {
  cancelAllRunningBackgroundTasks,
  cancelBackgroundTask,
  isBackgroundTaskBusy,
  useBackgroundTaskStore,
  useSessionBackgroundTasks,
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
  onDismiss,
}: {
  task: BackgroundTaskInfo;
  onCancel: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const { t } = useI18n();
  const busy = isBackgroundTaskBusy(task.status);
  const progressPercent = task.status === "completed" ? 100 : taskProgressPercent(task);
  const showIndeterminate = busy && progressPercent == null;
  const showBar = busy && (progressPercent != null || showIndeterminate);
  const resultText = !busy && !task.error && task.progress ? task.progress : null;

  const handleCopyError = useCallback(async () => {
    const text = task.error?.trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      showToast(t("shell.backgroundTasks.copyErrorDone"));
    } catch {
      showToast(t("shell.backgroundTasks.copyFailed"));
    }
  }, [t, task.error]);

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

        {busy && task.progress ? (
          <p className="background-tasks-row__message">{task.progress}</p>
        ) : null}

        {resultText ? (
          <p className="background-tasks-row__result">
            <span className="background-tasks-row__result-label">
              {t("shell.backgroundTasks.result")}
            </span>
            {resultText}
          </p>
        ) : null}

        {showBar ? (
          <div
            className={`background-tasks-row__bar${showIndeterminate ? " background-tasks-row__bar--indeterminate" : ""}${task.status === "completed" ? " background-tasks-row__bar--done" : ""}`}
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
          <div className="background-tasks-row__error">
            <p className="background-tasks-row__error-text">{task.error}</p>
            <button
              type="button"
              className="background-tasks-row__error-copy"
              title={t("shell.backgroundTasks.copyError")}
              aria-label={t("shell.backgroundTasks.copyError")}
              onClick={() => void handleCopyError()}
            >
              <IconCopy size={13} />
            </button>
          </div>
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
      ) : (
        <button
          type="button"
          className="background-tasks-row__dismiss"
          title={t("shell.backgroundTasks.dismiss")}
          aria-label={t("shell.backgroundTasks.dismiss")}
          onClick={() => onDismiss(task.id)}
        >
          <IconClose size={14} />
        </button>
      )}
    </li>
  );
}

export function BackgroundTasksWindow() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const open = useBackgroundTaskStore((s) => s.taskListOpen);
  const setOpen = useBackgroundTaskStore((s) => s.setTaskListOpen);
  const removeTask = useBackgroundTaskStore((s) => s.removeTask);
  const clearFinishedTasks = useBackgroundTaskStore((s) => s.clearFinishedTasks);
  const tasks = useSessionBackgroundTasks();
  const runningCount = tasks.filter((task) => isBackgroundTaskBusy(task.status)).length;
  const finishedCount = tasks.length - runningCount;

  const summaryText = useMemo(() => {
    if (runningCount > 0 && finishedCount > 0) {
      return t("shell.backgroundTasks.summaryMixed", {
        running: runningCount,
        finished: finishedCount,
      });
    }
    if (runningCount > 0) {
      return t("shell.backgroundTasks.runningCount", { count: runningCount });
    }
    return t("shell.backgroundTasks.finishedCount", { count: finishedCount });
  }, [t, runningCount, finishedCount]);

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

  const handleDismiss = useCallback((id: string) => {
    const task = useBackgroundTaskStore.getState().tasks[id];
    if (task?.kind === "file-transfer") {
      void useFileManagerStore.getState().dismissTransfer(id);
      return;
    }
    removeTask(id);
  }, [removeTask]);

  const openTaskCenter = useCallback(() => {
    setOpen(false);
    navigate(MODULE_PATHS.tasks);
  }, [navigate, setOpen]);

  const headerExtra = (
    <div className="background-tasks-header-actions">
      <Button type="button" variant="ghost" size="xs" onClick={openTaskCenter}>
        {t("shell.backgroundTasks.openTaskCenter")}
      </Button>
      {finishedCount > 0 ? (
        <Button type="button" variant="ghost" size="xs" onClick={clearFinishedTasks}>
          {t("shell.backgroundTasks.clearFinished")}
        </Button>
      ) : null}
      {runningCount > 0 ? (
        <Button type="button" variant="outline" size="xs" onClick={() => void handleCancelAll()}>
          {t("shell.backgroundTasks.cancelAll")}
        </Button>
      ) : null}
    </div>
  );

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
            <div
              className={`background-tasks-summary${runningCount === 0 ? " background-tasks-summary--idle" : ""}`}
            >
              <span className="background-tasks-summary__dot" aria-hidden />
              <span className="background-tasks-summary__text">{summaryText}</span>
            </div>
            <ul className="background-tasks-list">
              {tasks.map((task) => (
                <BackgroundTaskRow
                  key={task.id}
                  task={task}
                  onCancel={handleCancel}
                  onDismiss={handleDismiss}
                />
              ))}
            </ul>
          </>
        )}
      </div>
    </SubWindow>
  );
}
