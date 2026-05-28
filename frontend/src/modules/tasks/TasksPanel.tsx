import { useMemo, useState } from "react";
import { useActionStore, type WorkspaceAction } from "../../stores/actionStore";
import { useTopbarTabs } from "../../hooks/useTopbarTabs";
import { useI18n } from "../../i18n";

type TaskTab = "active" | "drafts" | "history";

const TASK_TABS: TaskTab[] = ["active", "drafts", "history"];

const DEMO_ACTIVE = [
  {
    id: "demo-upload",
    title: "Upload backup to S3",
    status: "running" as const,
    progress: 67,
    progressColor: "var(--accent)",
    meta: ["67% · 2.1 GB / 3.2 GB", "Speed: 12 MB/s", "ETA: 1m 32s", "Target: s3://backups/prod-db/"],
    steps: [
      { name: "Compress database dump", status: "Done · 45s", done: true },
      { name: "Generate checksum", status: "Done · 12s", done: true },
      { name: "Upload to S3", status: "Uploading...", active: true },
      { name: "Verify integrity", status: "Pending", pending: true },
    ],
  },
  {
    id: "demo-docker",
    title: "Pull nginx:1.25-alpine image",
    status: "running" as const,
    progress: 34,
    progressColor: "var(--warn)",
    meta: ["34% · 8.2 MB / 24.1 MB", "Layer 3/7", "Target: prod-web-01"],
  },
  {
    id: "demo-patrol",
    title: "Daily server patrol",
    status: "queued" as const,
    meta: ["Scheduled: 08:00 daily", "Targets: All Servers"],
  },
];

const DEMO_HISTORY = [
  { task: "DB Backup & Verify", type: "Workflow", status: "Success", duration: "4m 12s", target: "prod-db-master", time: "Today 08:00" },
  { task: "Restart nginx", type: "SSH", status: "Success", duration: "3s", target: "prod-web-01", time: "Yesterday 22:14" },
  { task: "DELETE FROM sessions", type: "SQL", status: "Failed", duration: "—", target: "prod-db-master", time: "Yesterday 18:02" },
];

function draftIconStyle(type: WorkspaceAction["type"]) {
  switch (type) {
    case "terminal":
    case "ssh":
      return { background: "var(--danger-soft)", color: "var(--danger)" };
    case "sql":
      return { background: "var(--accent-soft)", color: "var(--accent)" };
    case "docker":
      return { background: "var(--success-soft)", color: "var(--success)" };
    default:
      return { background: "var(--warn-soft)", color: "var(--warn)" };
  }
}

function statusBadge(status: WorkspaceAction["status"], t: (k: string) => string) {
  const map: Record<string, { label: string; tone: string }> = {
    draft: { label: t("tasks.status.draft"), tone: "muted" },
    blocked: { label: t("tasks.status.blocked"), tone: "warn" },
    confirmed: { label: t("tasks.status.confirmed"), tone: "accent" },
    running: { label: t("tasks.status.running"), tone: "accent" },
    completed: { label: t("tasks.status.completed"), tone: "success" },
    failed: { label: t("tasks.status.failed"), tone: "danger" },
    cancelled: { label: t("tasks.status.cancelled"), tone: "muted" },
  };
  const item = map[status] ?? { label: status, tone: "muted" };
  return <span className={`badge badge-${item.tone}`}>{item.label}</span>;
}

export function TasksPanel() {
  const { t } = useI18n();
  const [tab, setTab] = useState<TaskTab>("active");
  const actions = useActionStore((s) => s.actions);
  const confirmAction = useActionStore((s) => s.confirmAction);
  const cancelAction = useActionStore((s) => s.cancelAction);
  const completeAction = useActionStore((s) => s.completeAction);
  const clearCompleted = useActionStore((s) => s.clearCompleted);

  const activeActions = useMemo(
    () => actions.filter((a) => ["running", "confirmed"].includes(a.status)),
    [actions]
  );
  const draftActions = useMemo(
    () => actions.filter((a) => ["draft", "blocked"].includes(a.status)),
    [actions]
  );
  const historyActions = useMemo(
    () => actions.filter((a) => ["completed", "failed", "cancelled"].includes(a.status)),
    [actions]
  );

  const topbarTabs = useMemo(
    () =>
      TASK_TABS.map((id) => ({
        id,
        label: t(`tasks.tabs.${id}`),
        active: tab === id,
        badge:
          id === "active"
            ? { text: activeActions.length + DEMO_ACTIVE.length, tone: "accent" as const }
            : id === "drafts"
              ? { text: draftActions.length, tone: "warn" as const }
              : undefined,
      })),
    [tab, t, activeActions.length, draftActions.length]
  );

  useTopbarTabs(topbarTabs, {
    onSelect: (id) => setTab(id as TaskTab),
  }, { mode: "segment" });

  return (
    <div className="tasks-content">
      {tab === "active" && (
        <div className="task-panel active">
          {DEMO_ACTIVE.map((task) => (
            <div key={task.id} className="task-card">
              <div className="task-header">
                <h3>{task.title}</h3>
                <span className={`badge badge-${task.status === "queued" ? "warn" : "accent"}`}>
                  {task.status === "queued" ? t("tasks.status.queued") : t("tasks.status.running")}
                </span>
              </div>
              {task.progress !== undefined && (
                <div className="task-progress">
                  <div className="task-progress-fill" style={{ width: `${task.progress}%`, background: task.progressColor }} />
                </div>
              )}
              <div className="task-meta">
                {task.meta.map((line) => (
                  <span key={line}>{line}</span>
                ))}
              </div>
              {task.steps && (
                <div className="task-steps">
                  {task.steps.map((step) => (
                    <div key={step.name} className="task-step">
                      <span className={`step-icon ${step.done ? "text-success" : step.active ? "text-accent" : "text-muted"}`}>
                        {step.done ? "✓" : step.active ? "↻" : "○"}
                      </span>
                      <span className="step-name">{step.name}</span>
                      <span className={`step-status ${step.done ? "text-success" : step.active ? "text-accent" : "text-muted"}`}>
                        {step.status}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <div className="task-actions">
                <button type="button" className="btn btn-ghost btn-sm">{t("tasks.actions.pause")}</button>
                <button type="button" className="btn btn-danger btn-sm">{t("common.cancel")}</button>
              </div>
            </div>
          ))}

          {activeActions.map((action) => (
            <div key={action.id} className="task-card">
              <div className="task-header">
                <h3>{action.title}</h3>
                {statusBadge(action.status, t)}
              </div>
              <p className="task-desc">{action.description}</p>
              {action.command && <pre className="command-preview">{action.command}</pre>}
              <div className="task-meta">
                <span>{t("tasks.meta.resource")}: {action.resourceName ?? t("shell.nav.workspace")}</span>
                <span>{t("tasks.meta.source")}: {action.source}</span>
              </div>
              <div className="task-actions">
                {action.status === "running" && (
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => completeAction(action.id)}>
                    {t("tasks.actions.markDone")}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === "drafts" && (
        <div className="task-panel active">
          <div style={{ marginBottom: "var(--sp-4)" }}>
            <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>{t("tasks.drafts.title")}</h2>
            <p className="text-muted" style={{ fontSize: 12 }}>{t("tasks.drafts.desc")}</p>
          </div>

          {draftActions.length === 0 ? (
            <div className="empty-state compact">{t("tasks.drafts.empty")}</div>
          ) : (
            draftActions.map((action) => (
              <div key={action.id} className="draft-item">
                <div className="draft-icon" style={draftIconStyle(action.type)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                </div>
                <div className="draft-body">
                  <div className="draft-title">{action.title}</div>
                  <div className="draft-desc">
                    {action.description} · {action.resourceName ?? t("shell.nav.workspace")}
                  </div>
                </div>
                <div className="draft-actions">
                  {action.status === "blocked" && (
                    <>
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => confirmAction(action.id)}>
                        {t("common.execute")}
                      </button>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => cancelAction(action.id)}>
                        {t("common.cancel")}
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {tab === "history" && (
        <div className="task-panel active">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t("tasks.history.task")}</th>
                  <th>{t("tasks.history.type")}</th>
                  <th>{t("tasks.history.status")}</th>
                  <th>{t("tasks.history.duration")}</th>
                  <th>{t("tasks.history.target")}</th>
                  <th>{t("tasks.history.time")}</th>
                </tr>
              </thead>
              <tbody>
                {historyActions.map((action) => (
                  <tr key={action.id}>
                    <td style={{ fontWeight: 500 }}>{action.title}</td>
                    <td><span className="badge badge-accent">{action.type}</span></td>
                    <td>{statusBadge(action.status, t)}</td>
                    <td>—</td>
                    <td>{action.resourceName ?? "—"}</td>
                    <td>{new Date(action.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
                {DEMO_HISTORY.map((row) => (
                  <tr key={row.task}>
                    <td style={{ fontWeight: 500 }}>{row.task}</td>
                    <td><span className="badge badge-accent">{row.type}</span></td>
                    <td>
                      <span className={`badge badge-${row.status === "Success" ? "success" : "danger"}`}>
                        {row.status}
                      </span>
                    </td>
                    <td>{row.duration}</td>
                    <td>{row.target}</td>
                    <td>{row.time}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {historyActions.length > 0 && (
            <div style={{ marginTop: "var(--sp-3)" }}>
              <button type="button" className="btn btn-ghost btn-sm" onClick={clearCompleted}>
                {t("tasks.actions.clearCompleted")}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
