import { useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useI18n } from "../../i18n";
import { ContextMenu } from "../../components/ui/ContextMenu";
import { WarnAlert } from "../../components/ui/WarnAlert";
import { useDbSyncTaskStore } from "../../stores/dbSyncTaskStore";
import type { SyncTask } from "./toolbox/types";
import type { SchemaSidebarSectionConfig } from "./SchemaSidebarSection";
import { SchemaSidebarSection } from "./SchemaSidebarSection";

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

  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; task: SyncTask } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SyncTask | null>(null);

  const sortedTasks = useMemo(
    () => [...tasks].sort((a, b) => b.updatedAt - a.updatedAt),
    [tasks],
  );

  const panelBody = (
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
              id: "delete",
              label: t("database.syncTasks.delete"),
              danger: true,
              onClick: () => setDeleteTarget(ctxMenu.task),
            },
          ]}
          onClose={() => setCtxMenu(null)}
        />
      ) : null}

      <WarnAlert
        open={deleteTarget !== null}
        title={t("database.syncTasks.deleteTitle")}
        confirmLabel={t("database.syncTasks.delete")}
        cancelLabel={t("shell.topbar.cancel", { defaultValue: "取消" })}
        onConfirm={() => {
          if (deleteTarget) {
            deleteTask(deleteTarget.id);
          }
          setDeleteTarget(null);
        }}
        onClose={() => setDeleteTarget(null)}
      >
        {deleteTarget
          ? t("database.syncTasks.deleteConfirm", { name: deleteTarget.name })
          : null}
      </WarnAlert>
    </div>
  );

  if (section) {
    return <SchemaSidebarSection {...section}>{panelBody}</SchemaSidebarSection>;
  }

  return panelBody;
}
