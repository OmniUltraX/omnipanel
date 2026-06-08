import { useEffect, useMemo, useState, useCallback } from "react";
import { useTaskStore, initTaskProgressListener } from "../../stores/taskStore";
import { useTopbarTabs } from "../../hooks/useTopbarTabs";
import { useI18n } from "../../i18n";
import { Select } from "../../components/ui/Select";
import type {
  Task,
  TaskStatus,
  TaskType,
  TaskRisk,
  TaskSource,
  SaveTaskRequest,
} from "../../ipc/bindings";

type TaskTab = "active" | "drafts" | "history";

const TASK_TABS: TaskTab[] = ["active", "drafts", "history"];

/* ── 状态流转规则 ──────────────────────────────────── */
const STATUS_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  draft: ["confirmed", "cancelled"],
  blocked: ["confirmed", "cancelled"],
  confirmed: ["running", "cancelled"],
  running: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

/* ── 辅助渲染 ─────────────────────────────────────── */

function taskTypeIcon(type: TaskType) {
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

function statusBadge(status: TaskStatus, t: (k: string) => string) {
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

function riskBadge(risk: TaskRisk) {
  const map: Record<TaskRisk, { label: string; tone: string }> = {
    low: { label: "Low", tone: "muted" },
    medium: { label: "Medium", tone: "warn" },
    high: { label: "High", tone: "danger" },
    critical: { label: "Critical", tone: "danger" },
  };
  const item = map[risk] ?? { label: risk, tone: "muted" };
  return <span className={`badge badge-${item.tone}`}>{item.label}</span>;
}

function sourceBadge(source: TaskSource, t: (k: string) => string) {
  const map: Record<TaskSource, string> = {
    user: "👤",
    ai: "🤖",
    system: "⚙️",
  };
  return <span title={source}>{map[source] ?? source}</span>;
}

function formatDuration(startMs: number | null, endMs: number | null): string {
  if (!startMs) return "—";
  const end = endMs ?? Date.now();
  const diff = end - startMs;
  if (diff < 1000) return `${diff}ms`;
  if (diff < 60_000) return `${(diff / 1000).toFixed(1)}s`;
  const min = Math.floor(diff / 60_000);
  const sec = Math.floor((diff % 60_000) / 1000);
  return `${min}m ${sec}s`;
}

function formatTime(ms: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString();
}

/* ── 新建任务对话框 ────────────────────────────────── */

function NewTaskForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (req: SaveTaskRequest) => void;
}) {
  const { t } = useI18n();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [command, setCommand] = useState("");
  const [taskType, setTaskType] = useState<TaskType>("terminal");
  const [risk, setRisk] = useState<TaskRisk>("low");
  const [resourceId, setResourceId] = useState("");
  const [resourceName, setResourceName] = useState("");
  const [envTag, setEnvTag] = useState("dev");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    onCreated({
      id: null,
      task_type: taskType,
      title: title.trim(),
      description: description.trim(),
      resource_id: resourceId || "local",
      resource_name: resourceName || t("shell.nav.workspace"),
      env_tag: envTag,
      command: command.trim(),
      risk,
      status: risk !== "low" ? "blocked" : "draft",
      source: "user",
    });
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginBottom: "var(--sp-4)", fontSize: 16, fontWeight: 700 }}>
          {t("tasks.create.title")}
        </h3>
        <form onSubmit={handleSubmit}>
          <div className="form-field">
            <label>{t("tasks.create.titleLabel")}</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("tasks.create.titlePlaceholder")}
              autoFocus
            />
          </div>
          <div className="form-field">
            <label>{t("tasks.create.descLabel")}</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("tasks.create.descPlaceholder")}
              rows={2}
            />
          </div>
          <div className="form-field">
            <label>{t("tasks.create.commandLabel")}</label>
            <textarea
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder={t("tasks.create.commandPlaceholder")}
              rows={3}
              style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}
            />
          </div>
          <div style={{ display: "flex", gap: "var(--sp-3)", marginBottom: "var(--sp-3)" }}>
            <div className="form-field" style={{ flex: 1 }}>
              <label>{t("tasks.create.typeLabel")}</label>
              <Select
                value={taskType}
                onChange={(v) => setTaskType(v as TaskType)}
                searchable={false}
                options={[
                  { value: "terminal", label: "Terminal" },
                  { value: "sql", label: "SQL" },
                  { value: "docker", label: "Docker" },
                  { value: "server", label: "Server" },
                  { value: "ssh", label: "SSH" },
                  { value: "ai", label: "AI" },
                  { value: "workflow", label: "Workflow" },
                ]}
              />
            </div>
            <div className="form-field" style={{ flex: 1 }}>
              <label>{t("tasks.create.riskLabel")}</label>
              <Select
                value={risk}
                onChange={(v) => setRisk(v as TaskRisk)}
                searchable={false}
                options={[
                  { value: "low", label: "Low" },
                  { value: "medium", label: "Medium" },
                  { value: "high", label: "High" },
                  { value: "critical", label: "Critical" },
                ]}
              />
            </div>
            <div className="form-field" style={{ flex: 1 }}>
              <label>{t("tasks.create.envLabel")}</label>
              <Select
                value={envTag}
                onChange={setEnvTag}
                searchable={false}
                options={[
                  { value: "dev", label: "Dev" },
                  { value: "test", label: "Test" },
                  { value: "staging", label: "Staging" },
                  { value: "prod", label: "Prod" },
                ]}
              />
            </div>
          </div>
          <div style={{ display: "flex", gap: "var(--sp-3)", marginBottom: "var(--sp-4)" }}>
            <div className="form-field" style={{ flex: 1 }}>
              <label>{t("tasks.create.resourceLabel")}</label>
              <input
                type="text"
                value={resourceName}
                onChange={(e) => setResourceName(e.target.value)}
                placeholder={t("tasks.create.resourcePlaceholder")}
              />
            </div>
          </div>
          <div style={{ display: "flex", gap: "var(--sp-2)", justifyContent: "flex-end" }}>
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button type="submit" className="btn btn-primary" disabled={!title.trim()}>
              {t("common.create")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ── 任务详情面板 ──────────────────────────────────── */

function TaskDetailPanel({
  task,
  onClose,
  onStatusChange,
  onDelete,
  t,
}: {
  task: Task;
  onClose: () => void;
  onStatusChange: (id: string, status: TaskStatus) => void;
  onDelete: (id: string) => void;
  t: (k: string) => string;
}) {
  const transitions = STATUS_TRANSITIONS[task.status] ?? [];

  return (
    <div className="task-detail-panel">
      <div className="task-detail-header">
        <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)" }}>
          <h3 style={{ fontSize: 15, fontWeight: 700, flex: 1 }}>{task.title}</h3>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            ✕
          </button>
        </div>
        <div style={{ display: "flex", gap: "var(--sp-2)", alignItems: "center", marginTop: "var(--sp-2)" }}>
          {statusBadge(task.status, t)}
          {riskBadge(task.risk)}
          <span className="badge badge-accent">{task.task_type}</span>
          {sourceBadge(task.source, t)}
        </div>
      </div>

      {task.description && (
        <div className="task-detail-section">
          <div className="task-detail-label">{t("tasks.detail.description")}</div>
          <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>{task.description}</p>
        </div>
      )}

      {task.command && (
        <div className="task-detail-section">
          <div className="task-detail-label">{t("tasks.detail.command")}</div>
          <pre className="command-preview" style={{ fontSize: 12 }}>{task.command}</pre>
        </div>
      )}

      <div className="task-detail-section">
        <div className="task-detail-label">{t("tasks.detail.info")}</div>
        <table className="task-info-table">
          <tbody>
            <tr>
              <td className="text-muted">{t("tasks.meta.resource")}</td>
              <td>{task.resource_name || "—"}</td>
            </tr>
            <tr>
              <td className="text-muted">{t("tasks.detail.env")}</td>
              <td>{task.env_tag}</td>
            </tr>
            <tr>
              <td className="text-muted">{t("tasks.detail.createdAt")}</td>
              <td>{formatTime(task.created_at)}</td>
            </tr>
            <tr>
              <td className="text-muted">{t("tasks.detail.startedAt")}</td>
              <td>{formatTime(task.started_at)}</td>
            </tr>
            <tr>
              <td className="text-muted">{t("tasks.detail.finishedAt")}</td>
              <td>{formatTime(task.finished_at)}</td>
            </tr>
            <tr>
              <td className="text-muted">{t("tasks.history.duration")}</td>
              <td>{formatDuration(task.started_at, task.finished_at)}</td>
            </tr>
            <tr>
              <td className="text-muted">ID</td>
              <td style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>{task.id}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {task.output && (
        <div className="task-detail-section">
          <div className="task-detail-label">{t("tasks.detail.output")}</div>
          <pre className="command-preview" style={{ maxHeight: 300, overflow: "auto", fontSize: 11, whiteSpace: "pre-wrap" }}>
            {task.output}
          </pre>
        </div>
      )}

      {/* 状态流转按钮 */}
      {transitions.length > 0 && (
        <div className="task-detail-section">
          <div className="task-detail-label">{t("tasks.detail.actions")}</div>
          <div style={{ display: "flex", gap: "var(--sp-2)", flexWrap: "wrap" }}>
            {transitions.map((nextStatus) => (
              <button
                key={nextStatus}
                type="button"
                className={`btn btn-sm ${
                  ["completed"].includes(nextStatus)
                    ? "btn-primary"
                    : ["failed", "cancelled"].includes(nextStatus)
                      ? "btn-ghost"
                      : "btn-primary"
                }`}
                onClick={() => onStatusChange(task.id, nextStatus)}
              >
                {t(`tasks.status.${nextStatus}`)}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 删除按钮（仅终态任务可删除） */}
      {["completed", "failed", "cancelled"].includes(task.status) && (
        <div style={{ marginTop: "var(--sp-3)" }}>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ color: "var(--danger)" }}
            onClick={() => onDelete(task.id)}
          >
            {t("tasks.actions.delete")}
          </button>
        </div>
      )}
    </div>
  );
}

/* ── 主面板 ────────────────────────────────────────── */

export function TasksPanel() {
  const { t } = useI18n();
  const [tab, setTab] = useState<TaskTab>("active");
  const [showCreateForm, setShowCreateForm] = useState(false);

  const tasks = useTaskStore((s) => s.tasks);
  const selectedTaskId = useTaskStore((s) => s.selectedTaskId);
  const isLoading = useTaskStore((s) => s.isLoading);
  const loadTasks = useTaskStore((s) => s.loadTasks);
  const saveTask = useTaskStore((s) => s.saveTask);
  const updateStatus = useTaskStore((s) => s.updateStatus);
  const deleteTask = useTaskStore((s) => s.deleteTask);
  const clearCompleted = useTaskStore((s) => s.clearCompleted);
  const setSelectedTaskId = useTaskStore((s) => s.setSelectedTaskId);

  // 初始化：加载数据 + 监听事件
  useEffect(() => {
    loadTasks();
    initTaskProgressListener();
  }, [loadTasks]);

  // 分类任务
  const activeTasks = useMemo(
    () => tasks.filter((a) => ["running", "confirmed"].includes(a.status)),
    [tasks]
  );
  const draftTasks = useMemo(
    () => tasks.filter((a) => ["draft", "blocked"].includes(a.status)),
    [tasks]
  );
  const historyTasks = useMemo(
    () => tasks.filter((a) => ["completed", "failed", "cancelled"].includes(a.status)),
    [tasks]
  );

  // 选中的任务
  const selectedTask = useMemo(
    () => (selectedTaskId ? tasks.find((t) => t.id === selectedTaskId) ?? null : null),
    [tasks, selectedTaskId]
  );

  // Tab 配置
  const topbarTabs = useMemo(
    () =>
      TASK_TABS.map((id) => ({
        id,
        label: t(`tasks.tabs.${id}`),
        active: tab === id,
        badge:
          id === "active"
            ? { text: activeTasks.length, tone: "accent" as const }
            : id === "drafts"
              ? { text: draftTasks.length, tone: "warn" as const }
              : undefined,
      })),
    [tab, t, activeTasks.length, draftTasks.length]
  );

  useTopbarTabs(
    topbarTabs,
    { onSelect: (id) => setTab(id as TaskTab) },
    { mode: "segment" }
  );

  // 事件处理
  const handleCreate = useCallback(
    async (req: SaveTaskRequest) => {
      await saveTask(req);
      setShowCreateForm(false);
    },
    [saveTask]
  );

  const handleStatusChange = useCallback(
    async (id: string, status: TaskStatus) => {
      await updateStatus(id, status);
      // 刷新任务详情
      const store = useTaskStore.getState();
      await store.getTask(id);
    },
    [updateStatus]
  );

  const handleDelete = useCallback(
    async (id: string) => {
      await deleteTask(id);
    },
    [deleteTask]
  );

  const handleSelectTask = useCallback(
    (id: string) => {
      setSelectedTaskId(id === selectedTaskId ? null : id);
    },
    [setSelectedTaskId, selectedTaskId]
  );

  return (
    <div className="tasks-content" style={{ display: "flex", height: "100%", gap: 0 }}>
      {/* 左侧：任务列表 */}
      <div style={{ flex: 1, overflow: "auto", minWidth: 0 }}>
        {/* 创建按钮 */}
        <div style={{ padding: "var(--sp-3) var(--sp-4)", display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => setShowCreateForm(true)}
          >
            + {t("tasks.create.button")}
          </button>
        </div>

        {isLoading && tasks.length === 0 && (
          <div className="empty-state compact">{t("common.loading") ?? "Loading..."}</div>
        )}

        {/* Active Tab */}
        {tab === "active" && (
          <div className="task-panel active">
            {activeTasks.length === 0 ? (
              <div className="empty-state compact">{t("tasks.active.empty")}</div>
            ) : (
              activeTasks.map((task) => (
                <div
                  key={task.id}
                  className={`task-card ${selectedTaskId === task.id ? "selected" : ""}`}
                  onClick={() => handleSelectTask(task.id)}
                  style={{ cursor: "pointer" }}
                >
                  <div className="task-header">
                    <h3>{task.title}</h3>
                    {statusBadge(task.status, t)}
                  </div>
                  <p className="task-desc">{task.description}</p>
                  {task.command && <pre className="command-preview">{task.command}</pre>}
                  <div className="task-meta">
                    <span>
                      {t("tasks.meta.resource")}: {task.resource_name || t("shell.nav.workspace")}
                    </span>
                    <span>
                      {t("tasks.meta.source")}: {sourceBadge(task.source, t)} {task.source}
                    </span>
                    {task.started_at && (
                      <span>
                        {t("tasks.history.duration")}: {formatDuration(task.started_at, task.finished_at)}
                      </span>
                    )}
                  </div>
                  {/* 实时输出预览 */}
                  {task.output && (
                    <pre
                      className="command-preview"
                      style={{ maxHeight: 120, overflow: "auto", fontSize: 11, marginTop: "var(--sp-2)" }}
                    >
                      {task.output.slice(-2000)}
                    </pre>
                  )}
                </div>
              ))
            )}
          </div>
        )}

        {/* Drafts Tab */}
        {tab === "drafts" && (
          <div className="task-panel active">
            <div style={{ marginBottom: "var(--sp-4)" }}>
              <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>
                {t("tasks.drafts.title")}
              </h2>
              <p className="text-muted" style={{ fontSize: 12 }}>
                {t("tasks.drafts.desc")}
              </p>
            </div>

            {draftTasks.length === 0 ? (
              <div className="empty-state compact">{t("tasks.drafts.empty")}</div>
            ) : (
              draftTasks.map((task) => (
                <div
                  key={task.id}
                  className={`draft-item ${selectedTaskId === task.id ? "selected" : ""}`}
                  onClick={() => handleSelectTask(task.id)}
                  style={{ cursor: "pointer" }}
                >
                  <div className="draft-icon" style={taskTypeIcon(task.task_type)}>
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      width="14"
                      height="14"
                    >
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                  </div>
                  <div className="draft-body">
                    <div className="draft-title">{task.title}</div>
                    <div className="draft-desc">
                      {task.description} · {task.resource_name || t("shell.nav.workspace")}
                    </div>
                  </div>
                  <div className="draft-actions">
                    {task.status === "blocked" && (
                      <>
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleStatusChange(task.id, "confirmed");
                          }}
                        >
                          {t("common.execute")}
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleStatusChange(task.id, "cancelled");
                          }}
                        >
                          {t("common.cancel")}
                        </button>
                      </>
                    )}
                    {task.status === "draft" && (
                      <>
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleStatusChange(task.id, "confirmed");
                          }}
                        >
                          {t("common.execute")}
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleStatusChange(task.id, "cancelled");
                          }}
                        >
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

        {/* History Tab */}
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
                  {historyTasks.length === 0 ? (
                    <tr>
                      <td
                        colSpan={6}
                        className="text-muted"
                        style={{ textAlign: "center", padding: "var(--sp-4)" }}
                      >
                        {t("tasks.history.empty")}
                      </td>
                    </tr>
                  ) : (
                    historyTasks.map((task) => (
                      <tr
                        key={task.id}
                        onClick={() => handleSelectTask(task.id)}
                        style={{
                          cursor: "pointer",
                          background:
                            selectedTaskId === task.id ? "var(--bg-hover)" : undefined,
                        }}
                      >
                        <td style={{ fontWeight: 500 }}>{task.title}</td>
                        <td>
                          <span className="badge badge-accent">{task.task_type}</span>
                        </td>
                        <td>{statusBadge(task.status, t)}</td>
                        <td>{formatDuration(task.started_at, task.finished_at)}</td>
                        <td>{task.resource_name || "—"}</td>
                        <td>{formatTime(task.created_at)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            {historyTasks.length > 0 && (
              <div style={{ marginTop: "var(--sp-3)" }}>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => clearCompleted()}
                >
                  {t("tasks.actions.clearCompleted")}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 右侧：任务详情面板 */}
      {selectedTask && (
        <TaskDetailPanel
          task={selectedTask}
          onClose={() => setSelectedTaskId(null)}
          onStatusChange={handleStatusChange}
          onDelete={handleDelete}
          t={t}
        />
      )}

      {/* 新建任务对话框 */}
      {showCreateForm && (
        <NewTaskForm onClose={() => setShowCreateForm(false)} onCreated={handleCreate} />
      )}
    </div>
  );
}
