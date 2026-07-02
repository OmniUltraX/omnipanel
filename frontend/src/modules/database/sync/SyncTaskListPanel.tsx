import { useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useI18n } from "../../../i18n";
import { Button } from "../../../components/ui/Button";
import { ContextMenu } from "../../../components/ui/ContextMenu";
import { appConfirm } from "../../../lib/appConfirm";
import { quickInput } from "../../../lib/quickInput";
import { useDbSyncTaskStore } from "../../../stores/dbSyncTaskStore";
import type { SyncTask } from "../toolbox/types";
import type { SchemaSidebarSectionConfig } from "../schema/SchemaSidebarSection";
import { SchemaSidebarSection } from "../schema/SchemaSidebarSection";
import { CreateSyncTaskDialog } from "./CreateSyncTaskDialog";

interface SyncTaskListPanelProps {
  onOpenTask: (task: SyncTask) => void;
  onRunTask: (task: SyncTask) => void;
  section?: SchemaSidebarSectionConfig;
}

export function SyncTaskListPanel({ onOpenTask, onRunTask, section }: SyncTaskListPanelProps) {
  const { t } = useI18n();
  const tasks = useDbSyncTaskStore((s) => s.tasks);
  const activeTaskId = useDbSyncTaskStore((s) => s.activeTaskId);
  const deleteTask = useDbSyncTaskStore((s) => s.deleteTask);
  const updateTask = useDbSyncTaskStore((s) => s.updateTask);
  const addTask = useDbSyncTaskStore((s) => s.addTask);

  const [createOpen, setCreateOpen] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; task: SyncTask } | null>(null);

  const sortedTasks = useMemo(
    () => [...tasks].sort((a, b) => b.updatedAt - a.updatedAt),
    [tasks],
  );

  const handleDeleteTask = async (task: SyncTask) => {
    if (
      !(await appConfirm(
        t("database.syncTasks.deleteConfirm", { name: task.name }),
        t("database.syncTasks.deleteTitle"),
        {
          confirmLabel: t("database.syncTasks.delete"),
          cancelLabel: t("common.cancel"),
        },
      ))
    ) {
      return;
    }
    deleteTask(task.id);
  };

  const handleRenameTask = async (task: SyncTask) => {
    const name = await quickInput({
      title: t("database.syncTasks.renameTitle"),
      placeholder: t("database.syncTasks.namePlaceholder"),
      defaultValue: task.name,
      validate: (value) => (value.trim() ? null : t("database.syncTasks.nameRequired")),
    });
    if (!name) {
      return;
    }
    updateTask(task.id, { name: name.trim() });
  };

  const toolbar = (
    <div className="schema-toolbar schema-toolbar--inline">
      <Button
        variant="icon"
        title={t("database.syncTasks.newTask")}
        onClick={(event) => {
          event.stopPropagation();
          setCreateOpen(true);
        }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </Button>
    </div>
  );

  const taskListBody = (
    <div className="db-sync-task-panel">
      {sortedTasks.length === 0 ? (
        <div className="db-sync-task-empty">{t("database.syncTasks.empty")}</div>
      ) : (
        <ul className="db-sync-task-list">
          {sortedTasks.map((task) => {
            const kindLabel =
              task.kind === "dataSync"
                ? t("database.syncTasks.kindData")
                : t("database.syncTasks.kindSchema");
            return (
              <li key={task.id}>
                <button
                  type="button"
                  className={`db-sync-task-item${activeTaskId === task.id ? " db-sync-task-item--active" : ""}`}
                  onClick={() => onOpenTask(task)}
                  onContextMenu={(event: ReactMouseEvent) => {
                    event.preventDefault();
                    setCtxMenu({ x: event.clientX, y: event.clientY, task });
                  }}
                >
                  <span className="db-sync-task-item__name">{task.name}</span>
                  <span className="db-sync-task-item__meta">
                    <span className="db-sync-task-item__kind">{kindLabel}</span>
                    <span className="db-sync-task-item__count">
                      {t("database.syncTasks.tableCount", { count: task.config.selectedTables.length })}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {ctxMenu ? (
        <ContextMenu
          position={{ x: ctxMenu.x, y: ctxMenu.y }}
          items={[
            {
              id: "run",
              label: t("database.syncTasks.run"),
              onClick: () => onRunTask(ctxMenu.task),
            },
            {
              id: "rename",
              label: t("database.syncTasks.rename"),
              onClick: () => {
                const task = ctxMenu.task;
                setCtxMenu(null);
                void handleRenameTask(task);
              },
            },
            {
              id: "delete",
              label: t("database.syncTasks.delete"),
              danger: true,
              onClick: () => {
                const task = ctxMenu.task;
                setCtxMenu(null);
                void handleDeleteTask(task);
              },
            },
          ]}
          onClose={() => setCtxMenu(null)}
        />
      ) : null}
    </div>
  );

  return (
    <>
      {section ? (
        <SchemaSidebarSection {...section} actions={toolbar}>
          {taskListBody}
        </SchemaSidebarSection>
      ) : (
        taskListBody
      )}

      <CreateSyncTaskDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        createTask={addTask}
        onCreated={onOpenTask}
      />
    </>
  );
}
