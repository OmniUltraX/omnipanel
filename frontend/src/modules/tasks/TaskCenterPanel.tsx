import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { ModuleSegmentDock } from "../../components/dock";
import { ModuleModeIconRail, ModuleWorkspaceLayout } from "../../components/workspace";
import { WorkspaceEmptyPage } from "../../components/ui/workspace/WorkspaceEmptyPage";
import { Button } from "../../components/ui/primitives/Button";
import { useI18n } from "../../i18n";
import { usePersistedModuleTab } from "../../hooks/usePersistedModuleTab";
import { commands, type AuditEntry, type BuiltinToolAuditRecord } from "../../ipc/bindings";
import { useActionDraftStore, type ActionDraft } from "../../stores/actionDraftStore";
import { useAiOrchestrationStore, type AiTaskParent } from "../../stores/aiOrchestrationStore";
import { useBackgroundTaskStore, type BackgroundTaskInfo } from "../../stores/backgroundTaskStore";
import { useAiStore } from "../../stores/aiStore";
import { followAiIntent } from "../../lib/ai/uiFollow";
import { showToast } from "../../stores/toastStore";
import {
  cancelBackgroundTask,
  cancelAllRunningBackgroundTasks,
} from "../../stores/backgroundTaskStore";

type TaskCenterTab = "in-progress" | "pending" | "history";
const TASK_CENTER_TABS: TaskCenterTab[] = ["in-progress", "pending", "history"];

const HISTORY_LIMIT = 200;

/** 把时间戳格式化为本地短时间 */
function formatTs(ts: number): string {
  if (!ts) return "";
  try {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
  } catch {
    return String(ts);
  }
}

/** 持续时间毫秒转人类可读 */
function formatDuration(ms: number): string {
  if (!ms || ms < 0) return "-";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

/** 风险等级 → CSS 类后缀 */
function riskClass(risk?: string): string {
  switch (risk) {
    case "critical":
      return "risk-critical";
    case "high":
      return "risk-high";
    case "medium":
      return "risk-medium";
    default:
      return "risk-low";
  }
}

/** 状态 → CSS 类后缀 */
function statusClass(status: string): string {
  switch (status) {
    case "running":
    case "pending":
      return "status-running";
    case "completed":
    case "success":
      return "status-success";
    case "failed":
      return "status-failed";
    case "cancelled":
      return "status-cancelled";
    default:
      return "status-unknown";
  }
}

// ============================================================================
// In-Progress Tab
// ============================================================================

interface AiToolCallRunning {
  id: string;
  conversationId: string;
  messageId: string;
  toolName: string;
  status: string;
  argsPreview: string;
}

/** 从 aiStore.conversations 抽取所有 pending/running 的工具调用 */
function useRunningAiToolCalls(): AiToolCallRunning[] {
  const conversations = useAiStore((s) => s.conversations);
  return useMemo(() => {
    const result: AiToolCallRunning[] = [];
    for (const conv of conversations) {
      for (const msg of conv.messages) {
        if (msg.role !== "assistant" || !msg.parts) continue;
        for (const part of msg.parts) {
          if (part.type !== "tool-call") continue;
          if (part.status === "pending" || part.status === "running") {
            // args 可能很长，截断展示
            const argsPreview =
              part.arguments.length > 200
                ? `${part.arguments.slice(0, 200)}…`
                : part.arguments;
            result.push({
              id: part.id,
              conversationId: conv.id,
              messageId: msg.id,
              toolName: part.name,
              status: part.status,
              argsPreview,
            });
          }
        }
      }
    }
    return result;
  }, [conversations]);
}

function InProgressTab() {
  const { t } = useI18n();
  const aiTasks = useAiOrchestrationStore((s) => s.tasks);
  const cancelAiTask = useAiOrchestrationStore((s) => s.cancelTask);
  const removeAiTask = useAiOrchestrationStore((s) => s.removeTask);
  const bgTasks = useBackgroundTaskStore((s) => s.tasks);
  const runningToolCalls = useRunningAiToolCalls();

  const runningAiTasks = useMemo(
    () =>
      Object.values(aiTasks).filter(
        (task) => task.status === "running" || task.status === "pending",
      ),
    [aiTasks],
  );
  const recentAiTasks = useMemo(
    () =>
      Object.values(aiTasks)
        .filter((t) => t.status !== "running" && t.status !== "pending")
        .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
        .slice(0, 5),
    [aiTasks],
  );
  const runningBgTasks = useMemo(
    () =>
      Object.values(bgTasks).filter(
        (task) => task.status === "running" || task.status === "pending",
      ),
    [bgTasks],
  );

  const handleCancelAllBg = useCallback(async () => {
    try {
      await cancelAllRunningBackgroundTasks();
      showToast(t("taskCenter.inProgress.cancelAllDone"));
    } catch (e) {
      showToast(String(e));
    }
  }, [t]);

  const isEmpty =
    runningAiTasks.length === 0 &&
    recentAiTasks.length === 0 &&
    runningBgTasks.length === 0 &&
    runningToolCalls.length === 0;

  if (isEmpty) {
    return (
      <WorkspaceEmptyPage
        title={t("taskCenter.tabs.inProgress")}
        prompt={t("taskCenter.inProgress.empty")}
      />
    );
  }

  return (
    <div className="task-center-list">
      {/* === 进行中的 AI 工具调用（流式） === */}
      {runningToolCalls.length > 0 && (
        <section className="task-center-section">
          <h3 className="task-center-section__title">
            {t("taskCenter.inProgress.toolCalls")}
            <span className="task-center-section__count">{runningToolCalls.length}</span>
          </h3>
          <div className="task-center-cards">
            {runningToolCalls.map((call) => (
              <div key={`${call.conversationId}:${call.id}`} className="task-card task-card--tool">
                <div className="task-card__header">
                  <strong className="task-card__title">{call.toolName}</strong>
                  <span className={`task-card__status ${statusClass(call.status)}`}>
                    {call.status}
                  </span>
                </div>
                <pre className="task-card__preview">{call.argsPreview}</pre>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* === AI 编排任务（扇出/父子结构） === */}
      {runningAiTasks.length > 0 && (
        <section className="task-center-section">
          <h3 className="task-center-section__title">
            {t("taskCenter.inProgress.aiTasks")}
            <span className="task-center-section__count">{runningAiTasks.length}</span>
          </h3>
          <div className="task-center-cards">
            {runningAiTasks.map((task) => (
              <AiTaskCard
                key={task.id}
                task={task}
                onCancel={() => cancelAiTask(task.id)}
                onRemove={() => removeAiTask(task.id)}
              />
            ))}
          </div>
        </section>
      )}

      {/* === 后台长任务（带进度） === */}
      {runningBgTasks.length > 0 && (
        <section className="task-center-section">
          <h3 className="task-center-section__title">
            {t("taskCenter.inProgress.bgTasks")}
            <span className="task-center-section__count">{runningBgTasks.length}</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void handleCancelAllBg()}
              className="task-center-section__action"
            >
              {t("taskCenter.inProgress.cancelAll")}
            </Button>
          </h3>
          <div className="task-center-cards">
            {runningBgTasks.map((task) => (
              <BgTaskCard key={task.id} task={task} />
            ))}
          </div>
        </section>
      )}

      {/* === 最近完成的 AI 任务（5 条） === */}
      {recentAiTasks.length > 0 && (
        <section className="task-center-section">
          <h3 className="task-center-section__title">
            {t("taskCenter.inProgress.recent")}
          </h3>
          <div className="task-center-cards">
            {recentAiTasks.map((task) => (
              <AiTaskCard
                key={task.id}
                task={task}
                onCancel={() => cancelAiTask(task.id)}
                onRemove={() => removeAiTask(task.id)}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
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
    <div className={`task-card task-card--ai ${statusClass(task.status)}`}>
      <div className="task-card__header">
        <strong className="task-card__title">{task.title}</strong>
        <span className={`task-card__status ${statusClass(task.status)}`}>
          {task.status}
        </span>
      </div>
      <div className="task-card__meta">
        <span className="setting-hint">
          {t("taskCenter.inProgress.progress", { done, total: task.children.length })}
          {failed > 0 ? ` · ${t("taskCenter.inProgress.failed", { count: failed })}` : ""}
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
                      module: "ssh",
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
      {task.resultSummary && (
        <div className="task-card__summary">{task.resultSummary}</div>
      )}
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
  const progressPct = task.total > 0 ? Math.min(100, Math.round((task.index / task.total) * 100)) : 0;

  const handleCancel = useCallback(async () => {
    setCanceling(true);
    try {
      await cancelBackgroundTask(task.id);
      showToast(t("taskCenter.inProgress.cancelDone"));
    } catch (e) {
      showToast(String(e));
    } finally {
      setCanceling(false);
    }
  }, [task.id, t]);

  return (
    <div className={`task-card task-card--bg ${statusClass(task.status)}`}>
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
      {task.progress && <div className="task-card__progress-text">{task.progress}</div>}
      {task.error && <div className="task-card__error">{task.error}</div>}
      <div className="task-card__actions">
        {(task.status === "running" || task.status === "pending") && (
          <Button variant="ghost" size="sm" onClick={() => void handleCancel()} disabled={canceling}>
            {canceling ? t("taskCenter.actions.cancelling") : t("taskCenter.actions.cancel")}
          </Button>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Pending Tab (Action Drafts)
// ============================================================================

function PendingTab() {
  const { t } = useI18n();
  const drafts = useActionDraftStore((s) => s.drafts);
  const dismiss = useActionDraftStore((s) => s.dismiss);
  const confirm = useActionDraftStore((s) => s.confirm);

  const handleConfirm = useCallback(
    (id: string) => {
      void confirm(id)
        .then((r) => {
          if (r) showToast(r.slice(0, 200));
        })
        .catch((e) => showToast(String(e)));
    },
    [confirm],
  );

  if (drafts.length === 0) {
    return (
      <WorkspaceEmptyPage
        title={t("taskCenter.tabs.pending")}
        prompt={t("taskCenter.pending.empty")}
      />
    );
  }

  // 按创建时间倒序，新审批在最上
  const sorted = [...drafts].sort((a, b) => b.createdAt - a.createdAt);

  return (
    <div className="task-center-list">
      <section className="task-center-section">
        <h3 className="task-center-section__title">
          {t("taskCenter.pending.title")}
          <span className="task-center-section__count">{drafts.length}</span>
        </h3>
        <div className="task-center-cards">
          {sorted.map((draft) => (
            <DraftCard
              key={draft.id}
              draft={draft}
              onConfirm={() => handleConfirm(draft.id)}
              onDismiss={() => dismiss(draft.id)}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

function DraftCard({
  draft,
  onConfirm,
  onDismiss,
}: {
  draft: ActionDraft;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);

  const handleConfirm = useCallback(() => {
    setConfirming(true);
    onConfirm();
    // confirm 完成后 store 会移除该 draft，本组件 unmount；无需 reset confirming
  }, [onConfirm]);

  return (
    <div className={`task-card task-card--draft ${riskClass(draft.risk)}`}>
      <div className="task-card__header">
        <strong className="task-card__title">{draft.title}</strong>
        <span className={`task-card__risk ${riskClass(draft.risk)}`}>
          {draft.risk ?? "low"}
        </span>
      </div>
      <div className="task-card__meta">
        <span className="setting-hint">
          {draft.kind}
          {draft.toolName ? ` · ${draft.toolName}` : ""}
        </span>
        <span className="setting-hint">
          {draft.environment ? `env: ${draft.environment}` : ""}
          {draft.resourceId ? ` · ${draft.resourceId}` : ""}
        </span>
        <span className="setting-hint">{formatTs(draft.createdAt)}</span>
      </div>
      <pre className="task-card__preview">{draft.preview}</pre>
      {draft.riskCheck && draft.riskCheck.matches.length > 0 && (
        <div className="task-card__risk-reasons">
          {draft.riskCheck.matches.map((match, i) => (
            <div key={i} className="task-card__risk-reason">
              ⚠ {match.desc}（{match.level}）
            </div>
          ))}
        </div>
      )}
      <div className="task-card__actions">
        <Button variant="primary" size="sm" onClick={handleConfirm} disabled={confirming}>
          {confirming ? t("taskCenter.actions.confirming") : t("taskCenter.actions.confirm")}
        </Button>
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          {t("taskCenter.actions.dismiss")}
        </Button>
      </div>
    </div>
  );
}

// ============================================================================
// History Tab
// ============================================================================

function HistoryTab() {
  const { t } = useI18n();
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [toolRecords, setToolRecords] = useState<BuiltinToolAuditRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [subTab, setSubTab] = useState<"audit" | "tool">("audit");

  const load = useCallback(async () => {
    setLoading(true);
    let localError: string | null = null;
    try {
      const [auditRes, toolRes] = await Promise.all([
        commands.auditLogRecent(HISTORY_LIMIT),
        commands.builtinToolAuditList(HISTORY_LIMIT),
      ]);
      if (auditRes.status === "ok") {
        setAuditEntries(auditRes.data);
      } else {
        localError = auditRes.error.message;
      }
      if (toolRes.status === "ok") {
        setToolRecords(toolRes.data);
      } else if (!localError) {
        localError = toolRes.error.message;
      }
      setError(localError);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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
        <button
          type="button"
          className={`task-center-subtab ${subTab === "audit" ? "active" : ""}`}
          onClick={() => setSubTab("audit")}
        >
          {t("taskCenter.history.auditTab")}
          <span className="task-center-subtab__count">{auditEntries.length}</span>
        </button>
        <button
          type="button"
          className={`task-center-subtab ${subTab === "tool" ? "active" : ""}`}
          onClick={() => setSubTab("tool")}
        >
          {t("taskCenter.history.toolTab")}
          <span className="task-center-subtab__count">{toolRecords.length}</span>
        </button>
        <Button
          variant="ghost"
          size="sm"
          className="task-center-subtabs__refresh"
          onClick={() => void load()}
        >
          {t("taskCenter.history.refresh")}
        </Button>
      </div>

      {subTab === "audit" ? (
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
        {entries.map((entry, i) => (
          <div key={`${entry.ts}-${i}`} className="task-center-table__row">
            <div className="task-center-table__cell task-center-table__cell--ts">
              {formatTs(entry.ts)}
            </div>
            <div className="task-center-table__cell task-center-table__cell--action">
              <code>{entry.action}</code>
            </div>
            <div className="task-center-table__cell task-center-table__cell--target" title={entry.target}>
              {entry.target}
            </div>
            <div className="task-center-table__cell task-center-table__cell--env">
              {entry.envTag}
            </div>
            <div className={`task-center-table__cell task-center-table__cell--risk ${riskClass(entry.risk)}`}>
              {entry.risk}
            </div>
            <div className={`task-center-table__cell task-center-table__cell--status ${statusClass(entry.status)}`}>
              {entry.status}
            </div>
            <div
              className="task-center-table__cell task-center-table__cell--detail"
              title={entry.detail}
            >
              {entry.detail}
            </div>
          </div>
        ))}
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
              {formatTs(rec.ts)}
            </div>
            <div className="task-center-table__cell task-center-table__cell--source">
              {rec.source}
            </div>
            <div className="task-center-table__cell task-center-table__cell--action">
              <code>{rec.toolName}</code>
            </div>
            <div className="task-center-table__cell task-center-table__cell--duration">
              {formatDuration(rec.durationMs)}
            </div>
            <div className={`task-center-table__cell task-center-table__cell--status ${rec.success ? "status-success" : "status-failed"}`}>
              {rec.success ? "success" : "failed"}
            </div>
            <div
              className="task-center-table__cell task-center-table__cell--detail"
              title={rec.detail}
            >
              {rec.detail}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================================
// Main Panel
// ============================================================================

export function TaskCenterPanel() {
  const { t } = useI18n();
  const location = useLocation();
  const isActiveRoute = location.pathname === "/module/tasks";
  const [tab, setTab] = usePersistedModuleTab("tasks", "in-progress", TASK_CENTER_TABS);

  // 草稿数量徽章（左侧 icon rail 上展示）
  const draftCount = useActionDraftStore((s) => s.drafts.length);
  const aiTaskRunningCount = useAiOrchestrationStore(
    (s) =>
      Object.values(s.tasks).filter(
        (t) => t.status === "running" || t.status === "pending",
      ).length,
  );
  const bgTaskRunningCount = useBackgroundTaskStore(
    (s) =>
      Object.values(s.tasks).filter(
        (t) => t.status === "running" || t.status === "pending",
      ).length,
  );
  const inProgressBadge = aiTaskRunningCount + bgTaskRunningCount;

  const modeIconItems = useMemo(
    () => [
      {
        id: "in-progress",
        label: t("taskCenter.tabs.inProgress"),
        // 用 table 图标作为"任务列表"近似；徽章通过自定义节点叠加显示
        iconNode: (
          <span className="task-center-rail-icon">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} width={14} height={14} aria-hidden>
              <circle cx="8" cy="8" r="6" />
              <path d="M8 5v3l2 1" />
            </svg>
            {inProgressBadge > 0 ? (
              <span className="task-center-rail-badge">{inProgressBadge > 99 ? "99+" : inProgressBadge}</span>
            ) : null}
          </span>
        ),
      },
      {
        id: "pending",
        label: t("taskCenter.tabs.pending"),
        iconNode: (
          <span className="task-center-rail-icon">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} width={14} height={14} aria-hidden>
              <path d="M3 2h7l3 3v9H3V2z" />
              <path d="M10 2v3h3" />
              <path d="M5.5 9l1.5 1.5L10 7.5" />
            </svg>
            {draftCount > 0 ? (
              <span className="task-center-rail-badge task-center-rail-badge--warn">
                {draftCount > 99 ? "99+" : draftCount}
              </span>
            ) : null}
          </span>
        ),
      },
      {
        id: "history",
        label: t("taskCenter.tabs.history"),
        iconNode: (
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} width={14} height={14} aria-hidden>
            <path d="M2 4h12v9H2V4z" />
            <path d="M2 7h12M5 10h2M9 10h2" />
          </svg>
        ),
      },
    ],
    [t, inProgressBadge, draftCount],
  );

  const renderPanel = useCallback(
    (_tabId: string) => {
      switch (tab) {
        case "in-progress":
          return <InProgressTab />;
        case "pending":
          return <PendingTab />;
        case "history":
          return <HistoryTab />;
        default:
          return null;
      }
    },
    [tab],
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
            onChange={(id) => setTab(id as TaskCenterTab)}
          />
        }
      >
        <ModuleSegmentDock
          className="task-center-module-dock"
          variant="function"
          dockScope="tasks"
          moduleTitle={t("routes.tasks")}
          enabled={isActiveRoute}
          windowControl
          showTabBar={false}
          tabs={[{ id: tab, label: t(`taskCenter.tabs.${tab}`) }]}
          activeTabId={tab}
          onActiveTabChange={() => {}}
          renderPanel={renderPanel}
          emptyContent={
            <WorkspaceEmptyPage
              title={t("routes.tasks")}
              prompt={t("taskCenter.empty")}
            />
          }
        />
      </ModuleWorkspaceLayout>
    </div>
  );
}
