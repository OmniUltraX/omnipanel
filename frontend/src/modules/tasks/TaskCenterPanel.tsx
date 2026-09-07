import { useCallback, useEffect, useMemo, useState } from "react";
import { ModuleSegmentDock } from "../../components/dock";
import { ModuleModeIconRail, ModuleWorkspaceLayout } from "../../components/workspace";
import { WorkspaceEmptyPage } from "../../components/ui/workspace/WorkspaceEmptyPage";
import { Button } from "../../components/ui/primitives/Button";
import {
  IconClock,
  IconCopy,
  IconInbox,
  IconLightning,
} from "../../components/ui/icons/Icons";
import { useI18n } from "../../i18n";
import { useModuleRouteActive } from "../../lib/useModuleRouteActive";
import { usePersistedModuleTab } from "../../hooks/usePersistedModuleTab";
import { commands, type AuditEntry, type BuiltinToolAuditRecord } from "../../ipc/bindings";
import { useAiOrchestrationStore, type AiTaskParent } from "../../stores/aiOrchestrationStore";
import {
  cancelBackgroundTask,
  useBackgroundTaskStore,
  type BackgroundTaskInfo,
} from "../../stores/backgroundTaskStore";
import { followAiIntent } from "../../lib/ai/uiFollow";
import { SubConversationClusterCard } from "../../components/ai/SubConversationClusterCard";
import { showToast } from "../../stores/toastStore";
import { useLoopStore } from "../../stores/loopStore";
import { LoopTriageTab, LoopsTab, TurnTimelinePanel } from "./LoopTriagePanels";
import { TaskCenterSidebar } from "./TaskCenterSidebar";
import {
  INBOX_BUCKETS,
  LEGACY_TASK_CENTER_TAB_ALIASES,
  TASK_CENTER_TABS,
  coerceInboxBucket,
  coerceTaskCenterTab,
  selectionKey,
  type InboxBucket,
  type TaskCenterSelection,
} from "./taskCenterSelection";
import { useTaskCenterProjection } from "./projection/useTaskCenterProjection";
import type { TaskItem } from "./types";
import { isJobRunning } from "./types";
import { UserTodosPanel } from "./UserTodosPanel";
import { useUserTodoStore } from "../../stores/userTodoStore";
import { resolveMineView } from "./taskCenterSelection";

const HISTORY_LIMIT = 200;

function formatTs(ts: number): string {
  if (!ts) return "";
  try {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
  } catch {
    return String(ts);
  }
}

function formatDuration(ms: number): string {
  if (!ms || ms < 0) return "-";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

function riskClass(risk?: string): string {
  switch (risk) {
    case "critical":
      return "risk-critical";
    case "high":
      return "risk-high";
    case "medium":
    case "warning":
      return "risk-medium";
    default:
      return "risk-low";
  }
}

/** envTag 为 prod 或包含 prod（如 prod-cn）时视为生产环境 */
function isProdEnvTag(tag?: string | null): boolean {
  return !!tag && tag.toLowerCase().includes("prod");
}

function TaskItemMetaLine({ item }: { item: TaskItem }) {
  const { t } = useI18n();
  const parts = [item.module, item.kind, item.status].filter(Boolean);
  return (
    <div className="task-card__meta">
      <span className="setting-hint">{parts.join(" · ")}</span>
      {item.envTag ? (
        <span
          className={`env-badge${isProdEnvTag(item.envTag) ? " env-prod" : ""}`}
          title={item.envTag}
        >
          {isProdEnvTag(item.envTag) ? t("taskCenter.history.envProd") : item.envTag}
        </span>
      ) : null}
      {item.severity ? (
        <span className={`task-card__risk ${riskClass(item.severity)}`}>{item.severity}</span>
      ) : null}
      <span className="setting-hint">
        {formatTs(item.startedAt ?? item.createdAt)}
        {item.finishedAt ? ` → ${formatTs(item.finishedAt)}` : ""}
      </span>
    </div>
  );
}

function statusClass(status: string): string {
  switch (status) {
    case "running":
    case "pending":
    case "discovering":
    case "verifying":
      return "status-running";
    case "completed":
    case "success":
      return "status-success";
    case "failed":
      return "status-failed";
    case "cancelled":
    case "stopped":
      return "status-cancelled";
    default:
      return "status-unknown";
  }
}

function AiTaskCard({
  task,
  onCancel,
  onRemove,
}: {
  task: AiTaskParent;
  onCancel: () => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const done = task.children.filter(
    (c) =>
      c.status === "completed" || c.status === "failed" || c.status === "cancelled",
  ).length;
  const failed = task.children.filter((c) => c.status === "failed").length;
  const isFinished = task.status !== "running" && task.status !== "pending";

  return (
    <div className="task-card task-card--ai">
      <div className="task-card__header">
        <strong className="task-card__title">{task.title}</strong>
        <span className={`task-card__status ${statusClass(task.status)}`}>
          {task.status}
        </span>
      </div>
      <div className="task-card__meta">
        <span className="setting-hint">
          {t("taskCenter.activity.progress", { done, total: task.children.length })}
          {failed > 0 ? ` · ${t("taskCenter.activity.failed", { count: failed })}` : ""}
        </span>
        <span className="setting-hint">
          {formatTs(task.startedAt)}
          {task.finishedAt ? ` → ${formatTs(task.finishedAt)}` : ""}
        </span>
      </div>
      {task.children.length > 0 && (
        <ul className="task-card__children">
          {task.children.map((c) => (
            <li key={c.id} className="task-card__child">
              <button
                type="button"
                className="task-card__child-btn"
                onClick={() => {
                  if (c.resourceId) {
                    followAiIntent({
                      type: "openConnection",
                      module: "terminal",
                      resourceId: c.resourceId,
                    });
                  }
                }}
                disabled={!c.resourceId}
              >
                <span className="task-card__child-title">{c.title}</span>
                <span className={`task-card__child-status ${statusClass(c.status)}`}>
                  {c.status}
                </span>
              </button>
              {c.error && <div className="task-card__child-error">{c.error}</div>}
              {c.summary && <div className="task-card__child-summary">{c.summary}</div>}
            </li>
          ))}
        </ul>
      )}
      {task.resultSummary && <div className="task-card__summary">{task.resultSummary}</div>}
      <div className="task-card__actions">
        {!isFinished && (
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {t("taskCenter.actions.cancel")}
          </Button>
        )}
        {isFinished && (
          <Button variant="ghost" size="sm" onClick={onRemove}>
            {t("taskCenter.actions.dismiss")}
          </Button>
        )}
      </div>
    </div>
  );
}

function BgTaskCard({ task }: { task: BackgroundTaskInfo }) {
  const { t } = useI18n();
  const [canceling, setCanceling] = useState(false);
  const progressPct =
    task.total > 0 ? Math.min(100, Math.round((task.index / task.total) * 100)) : 0;

  const handleCancel = useCallback(async () => {
    setCanceling(true);
    try {
      await cancelBackgroundTask(task.id);
      showToast(t("taskCenter.activity.cancelDone"));
    } catch (e) {
      showToast(String(e));
    } finally {
      setCanceling(false);
    }
  }, [task.id, t]);

  return (
    <div className="task-card task-card--bg">
      <div className="task-card__header">
        <strong className="task-card__title">{task.title}</strong>
        <span className={`task-card__status ${statusClass(task.status)}`}>
          {task.status}
        </span>
      </div>
      <div className="task-card__meta">
        <span className="setting-hint">
          {task.module} · {task.kind}
        </span>
        <span className="setting-hint">
          {formatTs(task.startedAt)}
          {task.finishedAt ? ` → ${formatTs(task.finishedAt)}` : ""}
        </span>
      </div>
      {task.total > 0 && (
        <div className="task-card__progress">
          <div className="task-card__progress-bar" style={{ width: `${progressPct}%` }} />
          <span className="task-card__progress-text">
            {task.index}/{task.total}
            {typeof task.rowCompleted === "number" && typeof task.rowTotal === "number"
              ? ` · ${task.rowCompleted}/${task.rowTotal} rows`
              : ""}
          </span>
        </div>
      )}
      {task.progress ? <div className="task-card__message">{task.progress}</div> : null}
      {task.error ? (
        <div className="task-card__error">
          <span className="task-card__error-text">{task.error}</span>
          <button
            type="button"
            className="task-card__error-copy"
            title={t("shell.backgroundTasks.copyError")}
            aria-label={t("shell.backgroundTasks.copyError")}
            onClick={() => {
              void navigator.clipboard.writeText(task.error ?? "").then(
                () => showToast(t("shell.backgroundTasks.copyErrorDone")),
                () => showToast(t("shell.backgroundTasks.copyFailed")),
              );
            }}
          >
            <IconCopy size={13} />
          </button>
        </div>
      ) : null}
      {isJobRunning(task.status) ? (
        <div className="task-card__actions">
          <Button variant="ghost" size="sm" onClick={() => void handleCancel()} disabled={canceling}>
            {canceling ? t("taskCenter.actions.cancelling") : t("taskCenter.actions.cancel")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function LoopRunCard({ item }: { item: TaskItem }) {
  const run = useLoopStore((s) => (item.runId ? s.runs[item.runId] : undefined));
  return (
    <div className="task-card task-card--ai">
      <div className="task-card__header">
        <strong className="task-card__title">{item.title}</strong>
        <span className={`task-card__status ${statusClass(item.status)}`}>{item.status}</span>
      </div>
      <TaskItemMetaLine item={item} />
      {item.summary ? <pre className="task-card__preview">{item.summary}</pre> : null}
      {item.resultSummary ? (
        <div className="task-card__summary">{item.resultSummary}</div>
      ) : null}
      {item.error ? <div className="task-card__error">{item.error}</div> : null}
      {run?.turns?.length ? (
        <ul className="task-card__children">
          {run.turns.map((turn) => (
            <li key={`${turn.index}-${turn.phase}`} className="task-card__child">
              <span className="task-card__child-title">
                #{turn.index} {turn.phase}
              </span>
              <span className={`task-card__child-status ${turn.ok ? "status-success" : "status-failed"}`}>
                {turn.summary || (turn.ok ? "ok" : "fail")}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function TaskItemDetail({ item }: { item: TaskItem }) {
  const bgTasks = useBackgroundTaskStore((s) => s.tasks);
  const aiTasks = useAiOrchestrationStore((s) => s.tasks);
  const cancelAiTask = useAiOrchestrationStore((s) => s.cancelTask);
  const removeAiTask = useAiOrchestrationStore((s) => s.removeTask);

  if (item.source === "worker_pool" && item.backendJobId) {
    const bg = bgTasks[item.backendJobId];
    if (bg) {
      return (
        <div className="task-center-list">
          <BgTaskCard task={bg} />
        </div>
      );
    }
  }

  if (item.kind === "sub_conversation_cluster" && item.backendJobId) {
    return (
      <div className="task-center-list">
        <SubConversationClusterCard
          clusterId={item.backendJobId}
          defaultCollapsed={false}
        />
      </div>
    );
  }

  if (item.source === "orchestration" && item.backendJobId) {
    const ai = aiTasks[item.backendJobId];
    if (ai) {
      return (
        <div className="task-center-list">
          <AiTaskCard
            task={ai}
            onCancel={() => cancelAiTask(ai.id)}
            onRemove={() => removeAiTask(ai.id)}
          />
        </div>
      );
    }
  }

  if (item.source === "loop" || item.facet === "active_job") {
    return (
      <div className="task-center-list">
        <LoopRunCard item={item} />
      </div>
    );
  }

  return (
    <div className="task-center-list">
      <HistoryJobCard item={item} />
    </div>
  );
}

function HistoryJobCard({ item }: { item: TaskItem }) {
  return (
    <div className="task-card">
      <div className="task-card__header">
        <strong className="task-card__title">{item.title}</strong>
        <span className={`task-card__status ${statusClass(item.status)}`}>{item.status}</span>
      </div>
      <TaskItemMetaLine item={item} />
      {item.summary ? <pre className="task-card__preview">{item.summary}</pre> : null}
      {item.resultSummary ? <div className="task-card__summary">{item.resultSummary}</div> : null}
      {item.error ? <div className="task-card__error">{item.error}</div> : null}
    </div>
  );
}

function ActivityTab({
  items,
  selection,
}: {
  items: TaskItem[];
  selection: Extract<TaskCenterSelection, { tab: "activity" }> | null;
}) {
  const { t } = useI18n();

  if (selection?.kind === "loop-plan") {
    return <LoopsTab selectedId={selection.id} />;
  }

  if (items.length === 0 && !selection) {
    return (
      <WorkspaceEmptyPage
        title={t("taskCenter.tabs.activity")}
        prompt={t("taskCenter.activity.empty")}
      />
    );
  }

  const selectedId = selection?.kind === "job" ? selection.id : null;
  const item = items.find((i) => i.id === selectedId) ?? null;
  if (!item) {
    return (
      <WorkspaceEmptyPage
        title={t("taskCenter.tabs.activity")}
        prompt={t("taskCenter.selectItem")}
      />
    );
  }
  return <TaskItemDetail item={item} />;
}

function HistoryJobsDetail({
  items,
  selectedId,
  filterActive,
}: {
  items: TaskItem[];
  selectedId?: string;
  filterActive?: boolean;
}) {
  const { t } = useI18n();
  if (items.length === 0) {
    return (
      <WorkspaceEmptyPage
        title={t("taskCenter.history.jobsTab")}
        prompt={
          filterActive ? t("taskCenter.history.filterNoMatch") : t("taskCenter.history.empty")
        }
      />
    );
  }
  const item = (selectedId ? items.find((i) => i.id === selectedId) : null) ?? items[0];
  return (
    <div className="task-center-list">
      <HistoryJobCard item={item} />
    </div>
  );
}

function HistoryTab({
  bucket,
  jobId,
  historyJobs,
  filterActive,
}: {
  bucket: "jobs" | "audit" | "tool" | "timeline";
  jobId?: string;
  historyJobs: TaskItem[];
  filterActive?: boolean;
}) {
  const { t } = useI18n();
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [toolRecords, setToolRecords] = useState<BuiltinToolAuditRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    let localError: string | null = null;
    try {
      const [auditRes, toolRes] = await Promise.all([
        commands.auditLogRecent(HISTORY_LIMIT),
        commands.builtinToolAuditList(HISTORY_LIMIT),
      ]);
      if (auditRes.status === "ok") setAuditEntries(auditRes.data);
      else localError = String(auditRes.error);
      if (toolRes.status === "ok") setToolRecords(toolRes.data);
      else if (!localError) localError = String(toolRes.error);
      setError(localError);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (bucket === "audit" || bucket === "tool") void load();
  }, [bucket, load]);

  if (bucket === "jobs") {
    return (
      <HistoryJobsDetail
        items={historyJobs}
        selectedId={jobId}
        filterActive={filterActive}
      />
    );
  }
  if (bucket === "timeline") {
    return (
      <div className="task-center-list">
        <TurnTimelinePanel />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="task-center-loading">
        <span>{t("taskCenter.history.loading")}</span>
      </div>
    );
  }

  if (error && auditEntries.length === 0 && toolRecords.length === 0) {
    return (
      <div className="task-center-error">
        <span>{error}</span>
        <Button variant="ghost" size="sm" onClick={() => void load()}>
          {t("taskCenter.history.retry")}
        </Button>
      </div>
    );
  }

  return (
    <div className="task-center-list">
      <div className="task-center-subtabs">
        <span className="task-center-subtab active">
          {bucket === "audit" ? t("taskCenter.history.auditTab") : t("taskCenter.history.toolTab")}
          <span className="task-center-subtab__count">
            {bucket === "audit" ? auditEntries.length : toolRecords.length}
          </span>
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="task-center-subtabs__refresh"
          onClick={() => void load()}
        >
          {t("taskCenter.history.refresh")}
        </Button>
      </div>
      {bucket === "audit" ? (
        <AuditList entries={auditEntries} />
      ) : (
        <ToolAuditList records={toolRecords} />
      )}
    </div>
  );
}

function AuditList({ entries }: { entries: AuditEntry[] }) {
  const { t } = useI18n();
  if (entries.length === 0) {
    return (
      <WorkspaceEmptyPage
        title={t("taskCenter.history.auditTab")}
        prompt={t("taskCenter.history.empty")}
      />
    );
  }
  return (
    <div className="task-center-table">
      <div className="task-center-table__head">
        <div className="task-center-table__cell task-center-table__cell--ts">
          {t("taskCenter.history.colTime")}
        </div>
        <div className="task-center-table__cell task-center-table__cell--action">
          {t("taskCenter.history.colAction")}
        </div>
        <div className="task-center-table__cell task-center-table__cell--target">
          {t("taskCenter.history.colTarget")}
        </div>
        <div className="task-center-table__cell task-center-table__cell--env">
          {t("taskCenter.history.colEnv")}
        </div>
        <div className="task-center-table__cell task-center-table__cell--risk">
          {t("taskCenter.history.colRisk")}
        </div>
        <div className="task-center-table__cell task-center-table__cell--status">
          {t("taskCenter.history.colStatus")}
        </div>
        <div className="task-center-table__cell task-center-table__cell--detail">
          {t("taskCenter.history.colDetail")}
        </div>
      </div>
      <div className="task-center-table__body">
        {entries.map((entry, i) => {
          const prod = isProdEnvTag(entry.env_tag);
          return (
            <div
              key={`${entry.ts}-${i}`}
              className={`task-center-table__row${prod ? " task-center-table__row--prod" : ""}`}
            >
              <div className="task-center-table__cell task-center-table__cell--ts">
                {formatTs(entry.ts ?? 0)}
              </div>
              <div className="task-center-table__cell task-center-table__cell--action">
                <code>{entry.action}</code>
              </div>
              <div className="task-center-table__cell task-center-table__cell--target" title={entry.target}>
                {entry.target}
              </div>
              <div className="task-center-table__cell task-center-table__cell--env">
                {entry.env_tag ? (
                  <span
                    className={`env-badge${prod ? " env-prod" : ""}`}
                    title={entry.env_tag}
                  >
                    {prod ? t("taskCenter.history.envProd") : entry.env_tag}
                  </span>
                ) : (
                  "—"
                )}
              </div>
              <div
                className={`task-center-table__cell task-center-table__cell--risk ${riskClass(entry.risk)}`}
              >
                {entry.risk}
              </div>
              <div
                className={`task-center-table__cell task-center-table__cell--status ${statusClass(entry.status)}`}
              >
                {entry.status}
              </div>
              <div className="task-center-table__cell task-center-table__cell--detail" title={entry.detail}>
                {entry.detail}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ToolAuditList({ records }: { records: BuiltinToolAuditRecord[] }) {
  const { t } = useI18n();
  if (records.length === 0) {
    return (
      <WorkspaceEmptyPage
        title={t("taskCenter.history.toolTab")}
        prompt={t("taskCenter.history.empty")}
      />
    );
  }
  return (
    <div className="task-center-table">
      <div className="task-center-table__head">
        <div className="task-center-table__cell task-center-table__cell--ts">
          {t("taskCenter.history.colTime")}
        </div>
        <div className="task-center-table__cell task-center-table__cell--source">
          {t("taskCenter.history.colSource")}
        </div>
        <div className="task-center-table__cell task-center-table__cell--action">
          {t("taskCenter.history.colTool")}
        </div>
        <div className="task-center-table__cell task-center-table__cell--duration">
          {t("taskCenter.history.colDuration")}
        </div>
        <div className="task-center-table__cell task-center-table__cell--status">
          {t("taskCenter.history.colStatus")}
        </div>
        <div className="task-center-table__cell task-center-table__cell--detail">
          {t("taskCenter.history.colDetail")}
        </div>
      </div>
      <div className="task-center-table__body">
        {records.map((rec) => (
          <div key={rec.id} className="task-center-table__row">
            <div className="task-center-table__cell task-center-table__cell--ts">
              {formatTs(rec.ts ?? 0)}
            </div>
            <div className="task-center-table__cell task-center-table__cell--source">{rec.source}</div>
            <div className="task-center-table__cell task-center-table__cell--action">
              <code>{rec.toolName}</code>
            </div>
            <div className="task-center-table__cell task-center-table__cell--duration">
              {formatDuration(rec.durationMs ?? 0)}
            </div>
            <div
              className={`task-center-table__cell task-center-table__cell--status ${rec.success ? "status-success" : "status-failed"}`}
            >
              {rec.success ? "success" : "failed"}
            </div>
            <div className="task-center-table__cell task-center-table__cell--detail" title={rec.detail}>
              {rec.detail}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function TaskCenterPanel() {
  const { t } = useI18n();
  const { isActiveRoute, moduleLive } = useModuleRouteActive("tasks");
  const [tab, setTab] = usePersistedModuleTab(
    "tasks",
    "inbox",
    TASK_CENTER_TABS,
    { aliases: LEGACY_TASK_CENTER_TAB_ALIASES },
  );
  const [inboxBucket, setInboxBucket] = usePersistedModuleTab(
    "tasks-inbox",
    "mine",
    INBOX_BUCKETS,
  );
  const [selection, setSelection] = useState<TaskCenterSelection | null>(null);
  const [historyModuleFilter, setHistoryModuleFilter] = useState<string>("all");

  const { running, inbox, historyJobs, approvalCount } = useTaskCenterProjection();
  const loadUserTodos = useUserTodoStore((s) => s.loadLists);
  const userTodoOpenCount = useUserTodoStore((s) =>
    s.tasks.filter((t) => !t.completed).length,
  );

  useEffect(() => {
    void loadUserTodos();
  }, [loadUserTodos]);

  const inboxBadgeCount = inbox.length + userTodoOpenCount;

  const historyModules = useMemo(() => {
    const mods = new Set<string>();
    for (const job of historyJobs) {
      if (job.module) mods.add(job.module);
    }
    return Array.from(mods).sort((a, b) => a.localeCompare(b));
  }, [historyJobs]);

  const filteredHistoryJobs = useMemo(() => {
    if (historyModuleFilter === "all") return historyJobs;
    return historyJobs.filter((job) => job.module === historyModuleFilter);
  }, [historyJobs, historyModuleFilter]);

  useEffect(() => {
    if (historyModuleFilter !== "all" && !historyModules.includes(historyModuleFilter)) {
      setHistoryModuleFilter("all");
    }
  }, [historyModuleFilter, historyModules]);

  const handleTabChange = useCallback(
    (id: string) => {
      const next = coerceTaskCenterTab(id);
      setTab(next);
      if (next === "history") setSelection({ tab: "history", bucket: "jobs" });
      else if (next === "inbox") {
        setSelection({
          tab: "inbox",
          bucket: coerceInboxBucket(inboxBucket),
          view: inboxBucket === "mine" ? "myDay" : undefined,
        });
      } else setSelection(null);
    },
    [setTab, inboxBucket],
  );

  const handleInboxBucketChange = useCallback(
    (bucket: InboxBucket) => {
      setInboxBucket(bucket);
      setSelection(
        bucket === "mine"
          ? { tab: "inbox", bucket, view: "myDay" }
          : { tab: "inbox", bucket },
      );
    },
    [setInboxBucket],
  );

  const modeIconItems = useMemo(
    () => [
      {
        id: "inbox",
        label: t("taskCenter.tabs.inbox"),
        iconNode: (
          <span className="task-center-rail-icon">
            <IconInbox size={18} />
            {inboxBadgeCount > 0 ? (
              <span className="task-center-rail-badge task-center-rail-badge--warn">
                {inboxBadgeCount}
              </span>
            ) : null}
          </span>
        ),
      },
      {
        id: "activity",
        label: t("taskCenter.tabs.activity"),
        iconNode: (
          <span className="task-center-rail-icon">
            <IconLightning size={18} />
            {running.length > 0 ? (
              <span className="task-center-rail-badge">{running.length}</span>
            ) : null}
          </span>
        ),
      },
      {
        id: "history",
        label: t("taskCenter.tabs.history"),
        iconNode: <IconClock size={18} />,
      },
    ],
    [t, running.length, inboxBadgeCount],
  );

  const renderPanel = useCallback(
    (_tabId: string) => {
      switch (tab) {
        case "activity":
          return (
            <ActivityTab
              items={running}
              selection={selection?.tab === "activity" ? selection : null}
            />
          );
        case "inbox": {
          if (inboxBucket === "mine") {
            const mineSel =
              selection?.tab === "inbox" && selection.bucket === "mine"
                ? selection
                : null;
            const mineView = resolveMineView(mineSel ?? { view: "myDay" });
            return (
              <UserTodosPanel
                mineView={mineView}
                taskId={mineSel?.taskId}
                onSelectTask={(taskId) => {
                  setSelection({
                    tab: "inbox",
                    bucket: "mine",
                    view: mineView,
                    taskId,
                    id: mineView.startsWith("list:") ? mineView.slice(5) : undefined,
                  });
                }}
              />
            );
          }
          const findingId =
            selection?.tab === "inbox" && selection.bucket === "suggestions" && selection.id
              ? selection.id.replace(/^inbox:finding:/, "")
              : null;
          return <LoopTriageTab selectedId={findingId} />;
        }
        case "history":
          return (
            <HistoryTab
              bucket={selection?.tab === "history" ? selection.bucket : "jobs"}
              jobId={selection?.tab === "history" ? selection.id : undefined}
              historyJobs={filteredHistoryJobs}
              filterActive={historyModuleFilter !== "all"}
            />
          );
        default:
          return null;
      }
    },
    [tab, selection, running, filteredHistoryJobs, historyModuleFilter, inboxBucket],
  );

  const panelContentKeysByTab = useMemo(
    () => ({
      [tab]: selection
        ? `${selectionKey(selection)}:mod:${historyModuleFilter}:ib:${inboxBucket}`
        : `empty:${tab}:${approvalCount}:mod:${historyModuleFilter}:ib:${inboxBucket}`,
    }),
    [tab, selection, approvalCount, historyModuleFilter, inboxBucket],
  );

  return (
    <div className="task-center-panel">
      <ModuleWorkspaceLayout
        className="task-center-workspace"
        leftColumnTitle={t("routes.tasks")}
        leftIconRail={
          <ModuleModeIconRail
            items={modeIconItems}
            activeId={tab}
            onChange={handleTabChange}
          />
        }
        leftSidebar={
          <TaskCenterSidebar
            tab={tab}
            selection={selection}
            onSelect={setSelection}
            running={running}
            inbox={inbox}
            historyJobs={historyJobs}
            filteredHistoryJobs={filteredHistoryJobs}
            historyModules={historyModules}
            historyModuleFilter={historyModuleFilter}
            onHistoryModuleFilterChange={setHistoryModuleFilter}
            inboxBucket={inboxBucket}
            onInboxBucketChange={handleInboxBucketChange}
          />
        }
      >
        <ModuleSegmentDock
          className="task-center-module-dock"
          variant="function"
          dockScope="tasks"
          moduleTitle={t("routes.tasks")}
          enabled={isActiveRoute}
          contentSuspended={!moduleLive}
          windowControl
          showTabBar={false}
          tabs={[{ id: tab, label: t(`taskCenter.tabs.${tab}`) }]}
          activeTabId={tab}
          onActiveTabChange={() => {}}
          renderPanel={renderPanel}
          panelContentKeysByTab={panelContentKeysByTab}
          emptyContent={
            <WorkspaceEmptyPage title={t("routes.tasks")} prompt={t("taskCenter.empty")} />
          }
        />
      </ModuleWorkspaceLayout>
    </div>
  );
}
