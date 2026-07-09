import { useMemo, useState } from "react";
import { Button } from "../../../components/ui/primitives/Button";
import { appConfirm } from "../../../lib/appConfirm";
import { useI18n } from "../../../i18n";
import { useDbSyncTaskStore } from "../../../stores/dbSyncTaskStore";
import type {
  SyncTaskAnalysisRecord,
  SyncTaskAnalysisStatus,
  SyncTaskRunRecord,
  SyncTaskRunStatus,
} from "./types";

const EMPTY_RUNS: SyncTaskRunRecord[] = [];
const EMPTY_ANALYSIS: SyncTaskAnalysisRecord[] = [];

type HistoryTabId = "analysis" | "execution";

interface SyncTaskHistoryPanelProps {
  taskId: string | null;
  taskName: string;
}

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString();
}

function runStatusClass(status: SyncTaskRunStatus): string {
  return `db-sync-run-status db-sync-run-status--${status}`;
}

function analysisStatusClass(status: SyncTaskAnalysisStatus): string {
  return `db-sync-run-status db-sync-run-status--${status === "failed" ? "failed" : "completed"}`;
}

export function SyncTaskHistoryPanel({ taskId, taskName }: SyncTaskHistoryPanelProps) {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<HistoryTabId>("analysis");

  const runs = useDbSyncTaskStore((s) =>
    taskId ? (s.runHistory[taskId] ?? EMPTY_RUNS) : EMPTY_RUNS,
  );
  const analysisRecords = useDbSyncTaskStore((s) =>
    taskId ? (s.analysisHistory[taskId] ?? EMPTY_ANALYSIS) : EMPTY_ANALYSIS,
  );

  const clearRunHistory = useDbSyncTaskStore((s) => s.clearRunHistory);
  const clearAnalysisHistory = useDbSyncTaskStore((s) => s.clearAnalysisHistory);

  const sortedRuns = useMemo(
    () => [...runs].sort((a, b) => b.startedAt - a.startedAt),
    [runs],
  );
  const sortedAnalysis = useMemo(
    () => [...analysisRecords].sort((a, b) => b.finishedAt - a.finishedAt),
    [analysisRecords],
  );

  const runStatusLabel = (status: SyncTaskRunStatus) => {
    const key = `shell.backgroundTasks.status${status.charAt(0).toUpperCase()}${status.slice(1)}` as
      | "shell.backgroundTasks.statusPending"
      | "shell.backgroundTasks.statusRunning"
      | "shell.backgroundTasks.statusCompleted"
      | "shell.backgroundTasks.statusFailed"
      | "shell.backgroundTasks.statusCancelled";
    return t(key);
  };

  const analysisStatusLabel = (status: SyncTaskAnalysisStatus) => {
    if (status === "failed") {
      return t("database.toolbox.historyAnalysisStatusFailed");
    }
    if (status === "partial") {
      return t("database.toolbox.historyAnalysisStatusPartial");
    }
    return t("database.toolbox.historyAnalysisStatusCompleted");
  };

  const kindLabel = (kind: SyncTaskRunRecord["kind"]) =>
    kind === "dataSync" ? t("database.syncTasks.kindData") : t("database.syncTasks.kindSchema");

  const handleClearHistory = async () => {
    if (!taskId) {
      return;
    }
    const isAnalysisTab = activeTab === "analysis";
    const count = isAnalysisTab ? sortedAnalysis.length : sortedRuns.length;
    if (count === 0) {
      return;
    }
    const confirmed = await appConfirm(
      isAnalysisTab
        ? t("database.toolbox.historyClearAnalysisConfirm", { name: taskName })
        : t("database.toolbox.historyClearExecutionConfirm", { name: taskName }),
      isAnalysisTab
        ? t("database.toolbox.historyClearAnalysisTitle")
        : t("database.toolbox.historyClearExecutionTitle"),
      {
        confirmLabel: t("database.toolbox.historyClear"),
        cancelLabel: t("common.cancel"),
      },
    );
    if (!confirmed) {
      return;
    }
    if (isAnalysisTab) {
      clearAnalysisHistory(taskId);
    } else {
      clearRunHistory(taskId);
    }
  };

  if (!taskId) {
    return (
      <div className="db-sync-task-history">
        <p className="db-sync-run-history__empty">{t("database.toolbox.historyNoTask")}</p>
      </div>
    );
  }

  return (
    <div className="db-sync-task-history">
      <div className="db-sync-task-history__head">
        <div className="db-sync-task-history__tabs" role="tablist">
          <button
            type="button"
            role="tab"
            className={`db-toolbox-tab${activeTab === "analysis" ? " active" : ""}`}
            aria-selected={activeTab === "analysis"}
            onClick={() => setActiveTab("analysis")}
          >
            {t("database.toolbox.historyTabAnalysis")}
          </button>
          <button
            type="button"
            role="tab"
            className={`db-toolbox-tab${activeTab === "execution" ? " active" : ""}`}
            aria-selected={activeTab === "execution"}
            onClick={() => setActiveTab("execution")}
          >
            {t("database.toolbox.historyTabExecution")}
          </button>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="db-sync-task-history__clear"
          disabled={activeTab === "analysis" ? sortedAnalysis.length === 0 : sortedRuns.length === 0}
          onClick={() => void handleClearHistory()}
        >
          {t("database.toolbox.historyClear")}
        </Button>
      </div>

      {activeTab === "analysis" ? (
        sortedAnalysis.length === 0 ? (
          <p className="db-sync-run-history__empty">
            {t("database.toolbox.historyAnalysisEmpty", { name: taskName })}
          </p>
        ) : (
          <ul className="db-sync-run-history__list">
            {sortedAnalysis.map((record) => (
              <li key={record.id} className="db-sync-run-history__item">
                <div className="db-sync-run-history__item-head">
                  <span className={analysisStatusClass(record.status)}>
                    {analysisStatusLabel(record.status)}
                  </span>
                  <span className="db-sync-run-history__kind">{kindLabel(record.kind)}</span>
                  <span className="db-sync-run-history__tables">
                    {t("database.syncTasks.tableCount", { count: record.tableCount })}
                  </span>
                </div>
                <div className="db-sync-run-history__item-meta">
                  <span>
                    {t("database.toolbox.historyStartedAt")}: {formatTimestamp(record.startedAt)}
                  </span>
                  <span>
                    {t("database.toolbox.historyFinishedAt")}: {formatTimestamp(record.finishedAt)}
                  </span>
                </div>
                {record.summary?.trim() ? (
                  <p className="db-sync-run-history__progress">{record.summary}</p>
                ) : null}
                {record.tableNames.length > 0 ? (
                  <p
                    className="db-sync-run-history__table-names"
                    title={record.tableNames.join(", ")}
                  >
                    {record.tableNames.join(", ")}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )
      ) : sortedRuns.length === 0 ? (
        <p className="db-sync-run-history__empty">
          {t("database.toolbox.historyExecutionEmpty", { name: taskName })}
        </p>
      ) : (
        <ul className="db-sync-run-history__list">
          {sortedRuns.map((run) => (
            <li key={run.id} className="db-sync-run-history__item">
              <div className="db-sync-run-history__item-head">
                <span className={runStatusClass(run.status)}>{runStatusLabel(run.status)}</span>
                <span className="db-sync-run-history__kind">{kindLabel(run.kind)}</span>
                <span className="db-sync-run-history__tables">
                  {t("database.syncTasks.tableCount", { count: run.tableCount })}
                </span>
              </div>
              <div className="db-sync-run-history__item-meta">
                <span>{t("database.toolbox.historyStartedAt")}: {formatTimestamp(run.startedAt)}</span>
                {run.finishedAt != null ? (
                  <span>
                    {t("database.toolbox.historyFinishedAt")}: {formatTimestamp(run.finishedAt)}
                  </span>
                ) : null}
              </div>
              {run.progress?.trim() ? (
                <p className="db-sync-run-history__progress">{run.progress}</p>
              ) : null}
              {run.error ? <p className="db-sync-run-history__error">{run.error}</p> : null}
              {run.tableNames.length > 0 ? (
                <p className="db-sync-run-history__table-names" title={run.tableNames.join(", ")}>
                  {run.tableNames.join(", ")}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
