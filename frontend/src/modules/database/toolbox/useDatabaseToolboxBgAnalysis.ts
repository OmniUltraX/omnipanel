import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { appConfirm } from "../../../lib/appConfirm";
import {
  cancelDbBackgroundTask,
  startDbDataSyncBackgroundTask,
  startDbSchemaSyncBackgroundTask,
  useDbSyncBackgroundTaskEvents,
} from "./useDbSyncBackgroundTasks";
import type { BackgroundTaskInfo } from "../../../stores/backgroundTaskStore";
import {
  useBackgroundTaskStore,
} from "../../../stores/backgroundTaskStore";
import {
  applyIgnoredFieldsToAnalysisResult,
} from "./ignoredFields";
import {
  type DbConnectionConfig,
} from "../api";
import {
  findTableByName,
} from "./schemaSyncAlignedTables";
import {
  pickAnalysisCacheForRestore,
} from "./syncTaskAnalysisCache";
import {
  buildSchemaTableDiffFromSnapshots,
  type SchemaTableDiff,
} from "./schemaDiff";
import { useDbSyncTaskStore } from "../../../stores/dbSyncTaskStore";
import {
  type DataAnalysisResult,
  type SyncSideSnapshot,
  type SyncTaskAnalysisStatus,
  type SchemaTableNameCase,
  type TableTargetStatus,
  type ToolboxTabId,
} from "./types";
import {
  LARGE_TABLE_ROW_THRESHOLD,
  EXECUTE_TASK_KINDS,
  TERMINAL_EXECUTE_STATUSES,
  claimExecuteTaskCompletion,
} from "./databaseToolboxConstants";

export type UseDatabaseToolboxBgAnalysisDeps = {
  active: boolean;
  activeRef: MutableRefObject<any>;
  addAnalysisRecord: any;
  analysisAnalyzedAt: number | null;
  analysisConfigKey: string;
  analysisPendingBatchRef: MutableRefObject<any>;
  analyzingRef: MutableRefObject<any>;
  autoSavePausedRef: MutableRefObject<any>;
  bgDataTaskIdRef: MutableRefObject<any>;
  bgSchemaTaskIdRef: MutableRefObject<any>;
  clearAnalysisState: () => void;
  connections: DbConnectionConfig[];
  countingRef: MutableRefObject<any>;
  countingTables: Set<string>;
  dataAnalysisBatchByTaskRef: MutableRefObject<any>;
  dataAnalysisStartedAtRef: MutableRefObject<any>;
  executeTaskTablesRef: MutableRefObject<any>;
  handlePostExecuteAnalyzeRef: MutableRefObject<any>;
  ignoredFields: string[];
  lastAnalysisConfigKeyRef: MutableRefObject<any>;
  lastAnalyzedSelectionRef: MutableRefObject<any>;
  loadTargetSnapshot: any;
  ownedDataAnalysisTaskIdsRef: MutableRefObject<any>;
  ownedDataExecuteTaskIdsRef: MutableRefObject<any>;
  ownedSchemaAnalysisTaskIdsRef: MutableRefObject<any>;
  pendingPostExecuteAnalysisRef: MutableRefObject<any>;
  pendingPostExecuteTablesRef: MutableRefObject<any>;
  postExecuteReanalysisTablesRef: MutableRefObject<any>;
  prevAnalysisConfigKeyRef: MutableRefObject<any>;
  resolvedSchemaTableNameCase: SchemaTableNameCase;
  restoreAnalysisFromConfig: any;
  schemaAnalysisBatchByTaskRef: MutableRefObject<any>;
  schemaAnalysisDiffs: Record<string, SchemaTableDiff>;
  schemaAnalysisPendingBatchRef: MutableRefObject<any>;
  schemaAnalysisStartedAtRef: MutableRefObject<any>;
  schemaAnalyzing: boolean;
  schemaCompareCaseSensitive: boolean;
  schemaFetchingRef: MutableRefObject<any>;
  schemaTargetKey: string;
  setAnalysisAnalyzedAt: Dispatch<SetStateAction<number | null>>;
  setConflictDetailTable: Dispatch<SetStateAction<string | null>>;
  setCountingTables: Dispatch<SetStateAction<Set<string>>>;
  setSchemaAnalysisDiffs: Dispatch<SetStateAction<Record<string, SchemaTableDiff>>>;
  setSchemaAnalyzing: Dispatch<SetStateAction<boolean>>;
  setSchemaTableDiffs: Dispatch<SetStateAction<Record<string, SchemaTableDiff>>>;
  setSubmitNotice: Dispatch<SetStateAction<string | null>>;
  setSyncLockedTables: Dispatch<SetStateAction<Set<string>>>;
  setTableAnalysis: Dispatch<SetStateAction<Record<string, DataAnalysisResult>>>;
  setTargetCountingTables: Dispatch<SetStateAction<Set<string>>>;
  setTargetRowCounts: Dispatch<SetStateAction<Record<string, number | null>>>;
  sourceConnId: string;
  sourceDb: string;
  sourceSelected: Set<string>;
  sourceSelectedTableNames: string[];
  sourceSideBusy: boolean;
  sourceSnapshot: SyncSideSnapshot;
  sourceTableColumns: Record<string, import("../api").DbColumnMeta[]>;
  sourceTableIndexes: Record<string, import("../api").DbIndexMeta[]>;
  syncLockedTables: Set<string>;
  syncRunIdRef: MutableRefObject<any>;
  syncTaskId: string;
  t: (key: string, params?: Record<string, string | number>) => string;
  tab: ToolboxTabId;
  tableAnalysis: Record<string, DataAnalysisResult>;
  tableAnalysisRef: MutableRefObject<Record<string, DataAnalysisResult>>;
  tableTargetStatus: Record<string, TableTargetStatus>;
  targetConfigured: boolean;
  targetConnId: string;
  targetCountingRef: MutableRefObject<any>;
  targetCountingTables: Set<string>;
  targetDb: string;
  targetRowCounts: Record<string, number | null>;
  targetSnapshot: SyncSideSnapshot;
  targetTableNames: Set<string>;
  targetTablesLoading: boolean;
  taskLoadRef: MutableRefObject<any>;
};

export function useDatabaseToolboxBgAnalysis(deps: UseDatabaseToolboxBgAnalysisDeps) {
  const {
    active,
    activeRef,
    addAnalysisRecord,
    analysisAnalyzedAt,
    analysisConfigKey,
    analysisPendingBatchRef,
    analyzingRef,
    autoSavePausedRef,
    bgDataTaskIdRef,
    bgSchemaTaskIdRef,
    clearAnalysisState,
    connections,
    countingRef,
    countingTables,
    dataAnalysisBatchByTaskRef,
    dataAnalysisStartedAtRef,
    executeTaskTablesRef,
    handlePostExecuteAnalyzeRef,
    ignoredFields,
    lastAnalysisConfigKeyRef,
    lastAnalyzedSelectionRef,
    loadTargetSnapshot,
    ownedDataAnalysisTaskIdsRef,
    ownedDataExecuteTaskIdsRef,
    ownedSchemaAnalysisTaskIdsRef,
    pendingPostExecuteAnalysisRef,
    pendingPostExecuteTablesRef,
    postExecuteReanalysisTablesRef,
    prevAnalysisConfigKeyRef,
    resolvedSchemaTableNameCase,
    restoreAnalysisFromConfig,
    schemaAnalysisBatchByTaskRef,
    schemaAnalysisDiffs,
    schemaAnalysisPendingBatchRef,
    schemaAnalysisStartedAtRef,
    schemaAnalyzing,
    schemaCompareCaseSensitive,
    schemaFetchingRef,
    schemaTargetKey,
    setAnalysisAnalyzedAt,
    setConflictDetailTable,
    setCountingTables,
    setSchemaAnalysisDiffs,
    setSchemaAnalyzing,
    setSchemaTableDiffs,
    setSubmitNotice,
    setSyncLockedTables,
    setTableAnalysis,
    setTargetCountingTables,
    setTargetRowCounts,
    sourceConnId,
    sourceDb,
    sourceSelected,
    sourceSelectedTableNames,
    sourceSideBusy,
    sourceSnapshot,
    sourceTableColumns,
    sourceTableIndexes,
    syncLockedTables,
    syncRunIdRef,
    syncTaskId,
    t,
    tab,
    tableAnalysis,
    tableAnalysisRef,
    tableTargetStatus,
    targetConfigured,
    targetConnId,
    targetCountingRef,
    targetCountingTables,
    targetDb,
    targetRowCounts,
    targetSnapshot,
    targetTableNames,
    targetTablesLoading,
    taskLoadRef
  } = deps;

/** 配置指纹变化时尝试恢复或清空分析缓存 */
useEffect(() => {
  if (taskLoadRef.current || autoSavePausedRef.current) {
    return;
  }
  if (prevAnalysisConfigKeyRef.current === analysisConfigKey) {
    return;
  }
  const prevKey = prevAnalysisConfigKeyRef.current;
  prevAnalysisConfigKeyRef.current = analysisConfigKey;
  if (prevKey === null) {
    return;
  }

  const task = useDbSyncTaskStore.getState().tasks.find((item) => item.id === syncTaskId);
  const cached = task
    ? pickAnalysisCacheForRestore(task.config.analysisCache, analysisConfigKey)
    : null;
  if (cached && task) {
    restoreAnalysisFromConfig(task.config, analysisConfigKey);
    return;
  }

  clearAnalysisState();
}, [analysisConfigKey, syncTaskId, tab, restoreAnalysisFromConfig, clearAnalysisState]);

const handleBgTargetRowCount = useCallback((table: string, count: number | null) => {
  setTargetRowCounts((prev) => ({ ...prev, [table]: count }));
}, []);

const handleBgTableAnalysis = useCallback((table: string, result: DataAnalysisResult) => {
  analyzingRef.current.delete(table);
  const filtered = applyIgnoredFieldsToAnalysisResult(table, result, ignoredFields);
  setTableAnalysis((prev) => {
    const current = prev[table];
    if (current === filtered) {
      return prev;
    }
    if (
      current &&
      current.status === filtered.status &&
      current.diffRows === filtered.diffRows &&
      current.diffCacheId === filtered.diffCacheId &&
      current.error === filtered.error &&
      current.truncated === filtered.truncated &&
      JSON.stringify(current.diffs ?? []) === JSON.stringify(filtered.diffs ?? [])
    ) {
      return prev;
    }
    return { ...prev, [table]: filtered };
  });
}, [ignoredFields]);

const handleBgSchemaDiff = useCallback((table: string, diff: SchemaTableDiff) => {
  schemaFetchingRef.current.delete(table);
  setSchemaAnalysisDiffs((prev) => ({ ...prev, [table]: diff }));
  setSchemaTableDiffs((prev) => ({ ...prev, [table]: diff }));
}, []);

const handleBgAnalysisPending = useCallback((tables: string[], pending: boolean) => {
  for (const name of tables) {
    if (pending) {
      analyzingRef.current.add(name);
      setTableAnalysis((prev) => ({ ...prev, [name]: { status: "analyzing" } }));
    } else {
      analyzingRef.current.delete(name);
      setTableAnalysis((prev) => {
        if (prev[name]?.status !== "analyzing") {
          return prev;
        }
        const next = { ...prev };
        delete next[name];
        return next;
      });
    }
  }
}, []);

const handleBgTargetCounting = useCallback((tables: string[], counting: boolean) => {
  for (const name of tables) {
    if (counting) {
      targetCountingRef.current.add(name);
    } else {
      targetCountingRef.current.delete(name);
    }
  }
  setTargetCountingTables((prev) => {
    const next = new Set(prev);
    for (const name of tables) {
      if (counting) next.add(name);
      else next.delete(name);
    }
    return next;
  });
}, []);

const finalizeDataAnalysisTask = useCallback(
  (taskId: string) => {
    const batch = dataAnalysisBatchByTaskRef.current.get(taskId) ?? [];
    if (batch.length > 0) {
      handleBgTargetCounting(batch, false);
      for (const name of batch) {
        analyzingRef.current.delete(name);
      }
      setTableAnalysis((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const name of batch) {
          if (next[name]?.status === "analyzing") {
            delete next[name];
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }
    ownedDataAnalysisTaskIdsRef.current.delete(taskId);
    dataAnalysisBatchByTaskRef.current.delete(taskId);
    if (bgDataTaskIdRef.current === taskId) {
      bgDataTaskIdRef.current = null;
    }
  },
  [handleBgTargetCounting],
);

const finalizeSchemaAnalysisTask = useCallback(
  (taskId: string) => {
    const batch = schemaAnalysisBatchByTaskRef.current.get(taskId) ?? [];
    for (const name of batch) {
      schemaFetchingRef.current.delete(name);
    }
    // 目标侧独有表：本地轻量补全（无需后端 introspect）
    setSchemaAnalysisDiffs((prev) => {
      const next = { ...prev };
      for (const table of targetSnapshot.tables) {
        const inSource =
          findTableByName(sourceSnapshot.tables, table.name, schemaCompareCaseSensitive) !==
          undefined;
        if (inSource) continue;
        const displayName = table.name;
        if (next[displayName]) continue;
        next[displayName] = buildSchemaTableDiffFromSnapshots(
          displayName,
          undefined,
          table,
          schemaTargetKey,
        );
      }
      return next;
    });
    ownedSchemaAnalysisTaskIdsRef.current.delete(taskId);
    schemaAnalysisBatchByTaskRef.current.delete(taskId);
    if (bgSchemaTaskIdRef.current === taskId) {
      bgSchemaTaskIdRef.current = null;
    }
    setSchemaAnalyzing(false);
  },
  [
    targetSnapshot.tables,
    sourceSnapshot.tables,
    schemaCompareCaseSensitive,
    schemaTargetKey,
  ],
);

const matchDbSyncBgTaskId = useCallback(
  (taskId: string, context?: { table?: string; eventType?: string }) => {
    if (ownedDataExecuteTaskIdsRef.current.has(taskId)) {
      return false;
    }
    if (ownedDataAnalysisTaskIdsRef.current.has(taskId)) {
      return true;
    }
    if (ownedSchemaAnalysisTaskIdsRef.current.has(taskId)) {
      return true;
    }
    if (bgDataTaskIdRef.current === taskId) {
      return true;
    }
    if (bgSchemaTaskIdRef.current === taskId) {
      return true;
    }
    const pending = analysisPendingBatchRef.current;
    if (pending && !bgDataTaskIdRef.current) {
      const eventType = context?.eventType;
      if (eventType !== "count" && eventType !== "row_result") {
        return false;
      }
      if (context?.table && !pending.includes(context.table)) {
        return false;
      }
      ownedDataAnalysisTaskIdsRef.current.add(taskId);
      bgDataTaskIdRef.current = taskId;
      dataAnalysisBatchByTaskRef.current.set(taskId, pending);
      return true;
    }
    const schemaPending = schemaAnalysisPendingBatchRef.current;
    if (schemaPending && !bgSchemaTaskIdRef.current) {
      if (context?.eventType !== "schema_result") {
        return false;
      }
      if (context?.table && !schemaPending.includes(context.table)) {
        return false;
      }
      ownedSchemaAnalysisTaskIdsRef.current.add(taskId);
      bgSchemaTaskIdRef.current = taskId;
      schemaAnalysisBatchByTaskRef.current.set(taskId, schemaPending);
      return true;
    }
    return false;
  },
  [],
);

useDbSyncBackgroundTaskEvents({
  matchTaskId: matchDbSyncBgTaskId,
  sourceTableColumns,
  sourceTableIndexes,
  targetKey: schemaTargetKey,
  onTargetRowCount: handleBgTargetRowCount,
  onTableAnalysis: handleBgTableAnalysis,
  onSchemaDiff: handleBgSchemaDiff,
  onAnalysisTablesPending: handleBgAnalysisPending,
  onTargetCounting: handleBgTargetCounting,
});

const runBackgroundDataSync = useCallback(
  async (tableNames: string[]) => {
    if (tableNames.length === 0) return;

    const sourceConn = connections.find((c) => c.id === sourceConnId);
    const targetConn = connections.find((c) => c.id === targetConnId);
    if (!sourceConn || !targetConn || !sourceDb.trim() || !targetDb.trim()) return;

    const runId = syncRunIdRef.current;
    const previousTaskId = bgDataTaskIdRef.current;
    if (previousTaskId && ownedDataAnalysisTaskIdsRef.current.has(previousTaskId)) {
      await cancelDbBackgroundTask(previousTaskId);
      ownedDataAnalysisTaskIdsRef.current.delete(previousTaskId);
      dataAnalysisBatchByTaskRef.current.delete(previousTaskId);
    }
    bgDataTaskIdRef.current = null;
    analysisPendingBatchRef.current = tableNames;

    handleBgTargetCounting(tableNames, true);
    handleBgAnalysisPending(tableNames, true);

    try {
      const taskId = await startDbDataSyncBackgroundTask(
        sourceConn,
        targetConn,
        sourceDb,
        targetDb,
        tableNames,
        sourceTableColumns,
        ignoredFields,
      );
      analysisPendingBatchRef.current = null;
      if (syncRunIdRef.current !== runId) {
        await cancelDbBackgroundTask(taskId);
        ownedDataAnalysisTaskIdsRef.current.delete(taskId);
        dataAnalysisBatchByTaskRef.current.delete(taskId);
        handleBgTargetCounting(tableNames, false);
        handleBgAnalysisPending(tableNames, false);
        return;
      }
      ownedDataAnalysisTaskIdsRef.current.add(taskId);
      dataAnalysisBatchByTaskRef.current.set(taskId, tableNames);
      bgDataTaskIdRef.current = taskId;
    } catch (e) {
      analysisPendingBatchRef.current = null;
      handleBgTargetCounting(tableNames, false);
      handleBgAnalysisPending(tableNames, false);
      for (const name of tableNames) {
        setTableAnalysis((prev) => ({
          ...prev,
          [name]: {
            status: "error",
            error: typeof e === "string" ? e : String(e),
          },
        }));
      }
    }
  },
  [
    connections,
    sourceConnId,
    sourceDb,
    targetConnId,
    targetDb,
    sourceTableColumns,
    ignoredFields,
    handleBgAnalysisPending,
    handleBgTargetCounting,
  ],
);

const handleViewConflictDetail = useCallback(
  (tableName: string) => {
    setConflictDetailTable(tableName);

    const analysis = tableAnalysisRef.current[tableName];
    const needsAnalysis =
      !analysis ||
      analysis.status === "error" ||
      (analysis.status === "match" && tableTargetStatus[tableName] === "conflict");

    if (needsAnalysis && !analyzingRef.current.has(tableName)) {
      void runBackgroundDataSync([tableName]);
    }
  },
  [runBackgroundDataSync, tableTargetStatus],
);

const applyAnalysisCancelled = useCallback((kind: "data" | "schema" | "all") => {
  syncRunIdRef.current += 1;

  if (kind === "data" || kind === "all") {
    analyzingRef.current.clear();
    targetCountingRef.current.clear();
    setTargetCountingTables(new Set());
    setTableAnalysis((prev) => {
      const next: Record<string, DataAnalysisResult> = {};
      for (const [name, result] of Object.entries(prev)) {
        if (result.status !== "analyzing") {
          next[name] = result;
        }
      }
      return next;
    });
    lastAnalyzedSelectionRef.current = new Set(
      Object.entries(tableAnalysisRef.current)
        .filter(([, result]) => result.status === "match" || result.status === "diff" || result.status === "error")
        .map(([name]) => name),
    );
  }

  if (kind === "schema" || kind === "all") {
    schemaFetchingRef.current.clear();
    schemaAnalysisPendingBatchRef.current = null;
    setSchemaAnalyzing(false);
    setSchemaTableDiffs((prev) => {
      const next: Record<string, SchemaTableDiff> = {};
      for (const [name, diff] of Object.entries(prev)) {
        if (diff.status !== "checking") {
          next[name] = diff;
        }
      }
      return next;
    });
    setSchemaAnalysisDiffs((prev) => {
      const next: Record<string, SchemaTableDiff> = {};
      for (const [name, diff] of Object.entries(prev)) {
        if (diff.status !== "checking") {
          next[name] = diff;
        }
      }
      return next;
    });
  }
}, []);

useEffect(() => {
  let dispose: (() => void) | undefined;
  listen<BackgroundTaskInfo>("bg-task-update", (event) => {
    const task = event.payload;
    if (task.module !== "database") return;

    const ownsDataAnalysisTask =
      task.kind === "dbDataSyncAnalysis" &&
      (ownedDataAnalysisTaskIdsRef.current.has(task.id) ||
        task.id === bgDataTaskIdRef.current);
    if (ownsDataAnalysisTask) {
      if (task.status === "cancelled") {
        applyAnalysisCancelled("data");
      }
      if (
        task.status === "completed" ||
        task.status === "failed" ||
        task.status === "cancelled"
      ) {
        finalizeDataAnalysisTask(task.id);
      }
    }
    if (
      task.id === bgSchemaTaskIdRef.current ||
      ownedSchemaAnalysisTaskIdsRef.current.has(task.id)
    ) {
      if (task.status === "cancelled") {
        applyAnalysisCancelled("schema");
      }
      if (
        task.status === "completed" ||
        task.status === "failed" ||
        task.status === "cancelled"
      ) {
        finalizeSchemaAnalysisTask(task.id);
      }
    }
  })
    .then((fn) => {
      dispose = fn;
    })
    .catch(() => {});

  return () => {
    dispose?.();
  };
}, [applyAnalysisCancelled, finalizeDataAnalysisTask, finalizeSchemaAnalysisTask]);

useEffect(() => {
  if (!active) {
    return;
  }
  void useBackgroundTaskStore.getState().refreshRunning();
}, [active]);

const syncAnalysisBusy = useMemo(() => {
  if (tab !== "dataSync") return false;
  if (countingTables.size > 0 || targetCountingTables.size > 0) return true;
  return Object.values(tableAnalysis).some((result) => result.status === "analyzing");
}, [tab, countingTables, targetCountingTables, tableAnalysis]);

const schemaSyncBusy = useMemo(() => {
  if (tab !== "schemaSync") return false;
  return schemaAnalyzing;
}, [tab, schemaAnalyzing]);

const hasSchemaAnalysisResult = useMemo(
  () => analysisAnalyzedAt !== null && Object.keys(schemaAnalysisDiffs).length > 0,
  [analysisAnalyzedAt, schemaAnalysisDiffs],
);

const hasDataAnalysisResult = useMemo(
  () =>
    analysisAnalyzedAt !== null &&
    Object.values(tableAnalysis).some(
      (result) => result.status === "match" || result.status === "diff" || result.status === "error",
    ),
  [analysisAnalyzedAt, tableAnalysis],
);

const prevDataAnalysisBusyRef = useRef(false);
useEffect(() => {
  if (tab !== "dataSync") {
    return;
  }
  if (!prevDataAnalysisBusyRef.current && syncAnalysisBusy) {
    dataAnalysisStartedAtRef.current = Date.now();
  }
  if (prevDataAnalysisBusyRef.current && !syncAnalysisBusy) {
    const hasResults = Object.values(tableAnalysis).some(
      (result) => result.status !== "analyzing",
    );
    if (hasResults) {
      const finishedAt = Date.now();
      setAnalysisAnalyzedAt(finishedAt);
      lastAnalysisConfigKeyRef.current = analysisConfigKey;

      const tableNames = Object.entries(tableAnalysis)
        .filter(
          ([, result]) =>
            result.status === "match" ||
            result.status === "diff" ||
            result.status === "error",
        )
        .map(([name]) => name)
        .sort((a, b) => a.localeCompare(b));
      if (tableNames.length > 0 && syncTaskId) {
        const diffCount = tableNames.filter((name) => tableAnalysis[name]?.status === "diff").length;
        const errorCount = tableNames.filter((name) => tableAnalysis[name]?.status === "error").length;
        const matchCount = tableNames.filter((name) => tableAnalysis[name]?.status === "match").length;
        let status: SyncTaskAnalysisStatus = "completed";
        if (errorCount === tableNames.length) {
          status = "failed";
        } else if (errorCount > 0) {
          status = "partial";
        }
        addAnalysisRecord(syncTaskId, {
          id: `sync-analysis:${finishedAt}:${Math.random().toString(36).slice(2, 8)}`,
          kind: tab,
          status,
          tableCount: tableNames.length,
          tableNames,
          startedAt: dataAnalysisStartedAtRef.current ?? finishedAt,
          finishedAt,
          summary: t("database.toolbox.historyAnalysisSummaryData", {
            diff: diffCount,
            match: matchCount,
            error: errorCount,
          }),
          configKey: analysisConfigKey,
        });
      }
      dataAnalysisStartedAtRef.current = null;
    }
  }
  prevDataAnalysisBusyRef.current = syncAnalysisBusy;
}, [tab, syncAnalysisBusy, tableAnalysis, analysisConfigKey, syncTaskId, addAnalysisRecord, t]);

const prevSchemaAnalysisBusyRef = useRef(false);
useEffect(() => {
  if (tab !== "schemaSync") {
    return;
  }
  if (!prevSchemaAnalysisBusyRef.current && schemaSyncBusy) {
    if (schemaAnalysisStartedAtRef.current == null) {
      schemaAnalysisStartedAtRef.current = Date.now();
    }
  }
  if (prevSchemaAnalysisBusyRef.current && !schemaSyncBusy) {
    const hasResults = Object.values(schemaAnalysisDiffs).some(
      (diff) => diff.status !== "checking",
    );
    if (hasResults) {
      const finishedAt = Date.now();
      setAnalysisAnalyzedAt(finishedAt);
      lastAnalysisConfigKeyRef.current = analysisConfigKey;

      const tableNames = Object.entries(schemaAnalysisDiffs)
        .filter(([, diff]) => diff.status !== "checking")
        .map(([name]) => name)
        .sort((a, b) => a.localeCompare(b));
      if (tableNames.length > 0 && syncTaskId) {
        const diffCount = tableNames.filter((name) => {
          const status = schemaAnalysisDiffs[name]?.status;
          return status === "diff" || status === "new";
        }).length;
        const errorCount = tableNames.filter(
          (name) => schemaAnalysisDiffs[name]?.status === "error",
        ).length;
        const matchCount = tableNames.filter(
          (name) => schemaAnalysisDiffs[name]?.status === "match",
        ).length;
        let status: SyncTaskAnalysisStatus = "completed";
        if (errorCount === tableNames.length) {
          status = "failed";
        } else if (errorCount > 0) {
          status = "partial";
        }
        addAnalysisRecord(syncTaskId, {
          id: `sync-analysis:${finishedAt}:${Math.random().toString(36).slice(2, 8)}`,
          kind: tab,
          status,
          tableCount: tableNames.length,
          tableNames,
          startedAt: schemaAnalysisStartedAtRef.current ?? finishedAt,
          finishedAt,
          summary: t("database.toolbox.historyAnalysisSummarySchema", {
            diff: diffCount,
            match: matchCount,
            error: errorCount,
          }),
          configKey: analysisConfigKey,
        });
      }
      schemaAnalysisStartedAtRef.current = null;
    }
  }
  prevSchemaAnalysisBusyRef.current = schemaSyncBusy;
}, [
  tab,
  schemaSyncBusy,
  schemaAnalysisDiffs,
  analysisConfigKey,
  syncTaskId,
  addAnalysisRecord,
  t,
]);

// 勾选即触发逐条比对：仅在 dataSync tab 下，对源侧新勾选且目标库中存在的表做处理。
useEffect(() => {
  if (!active || tab !== "dataSync" || !targetConfigured || targetTablesLoading) return;
  if (taskLoadRef.current || autoSavePausedRef.current) return;
  if (syncLockedTables.size > 0) return;

  const eligible = new Set(
    sourceSelectedTableNames.filter((name) => targetTableNames.has(name)),
  );
  const newlySelected: string[] = [];
  for (const name of eligible) {
    if (lastAnalyzedSelectionRef.current.has(name)) {
      continue;
    }
    const existing = tableAnalysis[name];
    if (
      existing &&
      existing.status !== "analyzing" &&
      existing.status !== "unchecked"
    ) {
      lastAnalyzedSelectionRef.current.add(name);
      continue;
    }
    newlySelected.push(name);
  }
  if (newlySelected.length === 0) return;

  const oversized: string[] = [];
  const oversizedRows: Record<string, number> = {};
  for (const name of newlySelected) {
    const rows = targetRowCounts[name];
    if (typeof rows === "number" && rows >= LARGE_TABLE_ROW_THRESHOLD) {
      oversized.push(name);
      oversizedRows[name] = rows;
    }
  }
  if (oversized.length > 0) {
    const lines = oversized.map((name) =>
      t("database.toolbox.side.analysisLargeItem", {
        name,
        rows: oversizedRows[name]?.toLocaleString() ?? "—",
      }),
    );
    const normal = newlySelected.filter((name) => !oversized.includes(name));
    void (async () => {
      if (
        await appConfirm(
          lines.join("\n"),
          t("database.toolbox.side.analysisLargeTitle"),
          {
            confirmLabel: t("database.toolbox.side.analysisLargeConfirm"),
            cancelLabel: t("common.cancel"),
          },
        )
      ) {
        void runBackgroundDataSync(oversized);
        for (const name of oversized) {
          lastAnalyzedSelectionRef.current.add(name);
        }
      }
    })();
    if (normal.length > 0) {
      void runBackgroundDataSync(normal);
      for (const name of normal) {
        lastAnalyzedSelectionRef.current.add(name);
      }
    }
    return;
  }
  void runBackgroundDataSync(newlySelected);
  for (const name of newlySelected) {
    lastAnalyzedSelectionRef.current.add(name);
  }
}, [
  active,
  tab,
  targetConfigured,
  targetTablesLoading,
  sourceSelectedTableNames,
  targetTableNames,
  targetRowCounts,
  tableAnalysis,
  runBackgroundDataSync,
  syncLockedTables.size,
  t,
]);

const handleSchemaAnalyze = useCallback((options?: { keepPreviousResults?: boolean }) => {
  const targetConn = connections.find((c) => c.id === targetConnId);
  if (!targetConn || !targetDb.trim()) {
    return;
  }

  // 全库分析：对源侧全部表做后台对比（不再在前端本地 buildSchemaDiffsFromSnapshots）
  const tableNames = sourceSnapshot.tables.map((table) => table.name);
  if (tableNames.length === 0) {
    return;
  }

  syncRunIdRef.current += 1;
  schemaAnalysisStartedAtRef.current = Date.now();
  setSchemaAnalyzing(true);
  // 执行后重分析：保留上一轮结果直到新结果写入，避免同步完成瞬间整表变空白
  if (!options?.keepPreviousResults) {
    setSchemaAnalysisDiffs({});
    setAnalysisAnalyzedAt(null);
  }

  const checking: Record<string, SchemaTableDiff> = {};
  for (const name of tableNames) {
    checking[name] = { tableName: name, status: "checking", columns: [], indexes: [] };
    schemaFetchingRef.current.add(name);
  }
  setSchemaAnalysisDiffs((prev) =>
    options?.keepPreviousResults
      ? {
          ...prev,
          ...checking,
        }
      : checking,
  );

  void loadTargetSnapshot();

  void (async () => {
    const previousTaskId = bgSchemaTaskIdRef.current;
    if (previousTaskId && ownedSchemaAnalysisTaskIdsRef.current.has(previousTaskId)) {
      await cancelDbBackgroundTask(previousTaskId);
      ownedSchemaAnalysisTaskIdsRef.current.delete(previousTaskId);
      schemaAnalysisBatchByTaskRef.current.delete(previousTaskId);
    }

    schemaAnalysisPendingBatchRef.current = tableNames;
    try {
      const taskId = await startDbSchemaSyncBackgroundTask(
        targetConn,
        targetDb,
        tableNames,
        sourceTableColumns,
        sourceTableIndexes,
        targetSnapshot.tables,
        schemaCompareCaseSensitive,
        resolvedSchemaTableNameCase,
      );
      bgSchemaTaskIdRef.current = taskId;
      ownedSchemaAnalysisTaskIdsRef.current.add(taskId);
      schemaAnalysisBatchByTaskRef.current.set(taskId, tableNames);
      schemaAnalysisPendingBatchRef.current = null;
    } catch {
      schemaAnalysisPendingBatchRef.current = null;
      schemaFetchingRef.current.clear();
      setSchemaAnalyzing(false);
      if (!options?.keepPreviousResults) {
        setSchemaAnalysisDiffs({});
      }
      schemaAnalysisStartedAtRef.current = null;
    }
  })();
}, [
  connections,
  targetConnId,
  targetDb,
  sourceSnapshot.tables,
  sourceTableColumns,
  sourceTableIndexes,
  targetSnapshot.tables,
  schemaCompareCaseSensitive,
  resolvedSchemaTableNameCase,
  loadTargetSnapshot,
]);

const runDataSyncAnalysis = useCallback(
  (options?: { skipLargeTableConfirm?: boolean }) => {
    syncRunIdRef.current += 1;
    setTableAnalysis({});
    setAnalysisAnalyzedAt(null);
    lastAnalyzedSelectionRef.current = new Set();
    analyzingRef.current.clear();
    countingRef.current.clear();
    targetCountingRef.current.clear();
    setCountingTables(new Set());
    setTargetCountingTables(new Set());

    const eligible = sourceSelectedTableNames.filter((name) => targetTableNames.has(name));
    if (eligible.length === 0) {
      return;
    }

    const runAnalysis = (tableNames: string[]) => {
      void runBackgroundDataSync(tableNames);
      for (const name of tableNames) {
        lastAnalyzedSelectionRef.current.add(name);
      }
    };

    if (options?.skipLargeTableConfirm) {
      runAnalysis(eligible);
      return;
    }

    const oversized: string[] = [];
    const oversizedRows: Record<string, number> = {};
    for (const name of eligible) {
      const rows = targetRowCounts[name];
      if (typeof rows === "number" && rows >= LARGE_TABLE_ROW_THRESHOLD) {
        oversized.push(name);
        oversizedRows[name] = rows;
      }
    }

    if (oversized.length > 0) {
      const lines = oversized.map((name) =>
        t("database.toolbox.side.analysisLargeItem", {
          name,
          rows: oversizedRows[name]?.toLocaleString() ?? "—",
        }),
      );
      void (async () => {
        if (
          await appConfirm(
            lines.join("\n"),
            t("database.toolbox.side.analysisLargeTitle"),
            {
              confirmLabel: t("database.toolbox.side.analysisLargeConfirm"),
              cancelLabel: t("common.cancel"),
            },
          )
        ) {
          runAnalysis(oversized);
        }
      })();
      const normal = eligible.filter((name) => !oversized.includes(name));
      if (normal.length > 0) {
        runAnalysis(normal);
      }
      return;
    }

    runAnalysis(eligible);
  },
  [
    sourceSelectedTableNames,
    targetTableNames,
    targetRowCounts,
    runBackgroundDataSync,
    t,
  ],
);

const handleDataAnalyze = useCallback(() => {
  runDataSyncAnalysis();
}, [runDataSyncAnalysis]);

const handleAnalyzeTable = useCallback(
  (tableName: string) => {
    if (tab !== "dataSync") {
      return;
    }
    if (!targetTableNames.has(tableName)) {
      return;
    }
    if (syncLockedTables.has(tableName)) {
      return;
    }
    if (analyzingRef.current.has(tableName) || targetCountingTables.has(tableName)) {
      return;
    }

    const runSingle = () => {
      lastAnalyzedSelectionRef.current.add(tableName);
      void runBackgroundDataSync([tableName]);
    };

    const rows = targetRowCounts[tableName];
    if (typeof rows === "number" && rows >= LARGE_TABLE_ROW_THRESHOLD) {
      void (async () => {
        if (
          await appConfirm(
            t("database.toolbox.side.analysisLargeItem", {
              name: tableName,
              rows: rows.toLocaleString(),
            }),
            t("database.toolbox.side.analysisLargeTitle"),
            {
              confirmLabel: t("database.toolbox.side.analysisLargeConfirm"),
              cancelLabel: t("common.cancel"),
            },
          )
        ) {
          runSingle();
        }
      })();
      return;
    }

    runSingle();
  },
  [
    tab,
    targetTableNames,
    syncLockedTables,
    targetCountingTables,
    targetRowCounts,
    runBackgroundDataSync,
    t,
  ],
);

const dataSyncAnalyzingTables = useMemo(() => {
  if (tab !== "dataSync") {
    return new Set<string>();
  }
  const names = new Set<string>();
  for (const [name, result] of Object.entries(tableAnalysis)) {
    if (result.status === "analyzing") {
      names.add(name);
    }
  }
  for (const name of targetCountingTables) {
    names.add(name);
  }
  return names;
}, [tab, tableAnalysis, targetCountingTables]);

const runAnalysisForTables = useCallback(
  (tableNames: string[]) => {
    const eligible = tableNames.filter((name) => targetTableNames.has(name));
    if (eligible.length === 0) {
      return;
    }
    for (const name of eligible) {
      lastAnalyzedSelectionRef.current.add(name);
    }
    void runBackgroundDataSync(eligible);
  },
  [targetTableNames, runBackgroundDataSync],
);

const handlePostExecuteAnalyze = useCallback(
  (tableNames?: string[]) => {
    if (tab === "schemaSync") {
      // 同步刚写完目标结构：重分析时保留上一轮结果，避免失败时整页空白
      handleSchemaAnalyze({ keepPreviousResults: true });
      return;
    }
    if (tableNames && tableNames.length > 0) {
      runAnalysisForTables(tableNames);
      return;
    }
    runDataSyncAnalysis({ skipLargeTableConfirm: true });
  },
  [tab, handleSchemaAnalyze, runDataSyncAnalysis, runAnalysisForTables],
);

handlePostExecuteAnalyzeRef.current = handlePostExecuteAnalyze;

useEffect(() => {
  let dispose: (() => void) | undefined;
  listen<BackgroundTaskInfo>("bg-task-update", (event) => {
    const task = event.payload;
    if (!EXECUTE_TASK_KINDS.has(task.kind)) {
      return;
    }
    if (!TERMINAL_EXECUTE_STATUSES.has(task.status)) {
      return;
    }
    if (!claimExecuteTaskCompletion(task.id)) {
      return;
    }

    const tablesFromSubmit = executeTaskTablesRef.current.get(task.id);
    const runs = useDbSyncTaskStore.getState().runHistory[syncTaskId] ?? [];
    const matchedRun = runs.find((run) => run.bgTaskId === task.id && run.kind === tab);
    const ownedExecute = ownedDataExecuteTaskIdsRef.current.has(task.id);
    if (!ownedExecute && !matchedRun) {
      return;
    }

    const tablesToReanalyze = matchedRun?.tableNames ?? tablesFromSubmit ?? [];
    ownedDataExecuteTaskIdsRef.current.delete(task.id);
    executeTaskTablesRef.current.delete(task.id);

    if (task.status === "failed") {
      if (task.error?.trim()) {
        setSubmitNotice(task.error);
      }
      if (tab === "dataSync") {
        for (const name of tablesToReanalyze) {
          postExecuteReanalysisTablesRef.current.delete(name);
        }
        if (tablesToReanalyze.length > 0) {
          setSyncLockedTables((prev) => {
            const next = new Set(prev);
            for (const name of tablesToReanalyze) {
              next.delete(name);
            }
            return next.size === prev.size ? prev : next;
          });
        }
      }
      return;
    }

    if (task.status !== "completed") {
      return;
    }

    if (tab === "dataSync") {
      for (const name of tablesToReanalyze) {
        postExecuteReanalysisTablesRef.current.add(name);
      }
      if (tablesToReanalyze.length > 0) {
        setTableAnalysis((prev) => {
          let changed = false;
          const next = { ...prev };
          for (const name of tablesToReanalyze) {
            if (next[name]?.status === "analyzing") {
              continue;
            }
            next[name] = { status: "analyzing" };
            analyzingRef.current.add(name);
            changed = true;
          }
          return changed ? next : prev;
        });
        setSyncLockedTables((prev) => {
          const next = new Set(prev);
          for (const name of tablesToReanalyze) {
            next.add(name);
          }
          return next.size === prev.size ? prev : next;
        });
      }
    }
    if (tablesToReanalyze.length === 0 && tab !== "schemaSync") {
      return;
    }
    if (activeRef.current) {
      queueMicrotask(() => {
        handlePostExecuteAnalyzeRef.current(
          tab === "schemaSync" ? undefined : tablesToReanalyze,
        );
      });
    } else {
      pendingPostExecuteAnalysisRef.current = true;
      pendingPostExecuteTablesRef.current =
        tab === "schemaSync" ? [] : tablesToReanalyze;
    }
  })
    .then((fn) => {
      dispose = fn;
    })
    .catch(() => {});

  return () => {
    dispose?.();
  };
}, [syncTaskId, tab]);

const handleAnalyze =
  tab === "schemaSync" ? handleSchemaAnalyze : handleDataAnalyze;

const analyzeBusy =
  tab === "schemaSync" ? schemaAnalyzing : syncAnalysisBusy;

const hasAnalysisResult =
  tab === "schemaSync" ? hasSchemaAnalysisResult : hasDataAnalysisResult;

const dataSyncEligibleTableCount = useMemo(() => {
  if (tab !== "dataSync") {
    return 0;
  }
  return sourceSelectedTableNames.filter((name) => targetTableNames.has(name)).length;
}, [tab, sourceSelectedTableNames, targetTableNames]);

const canAnalyzeAll = useMemo(() => {
  if (tab !== "dataSync") {
    return false;
  }
  if (!targetConfigured || !sourceDb.trim() || !targetDb.trim()) {
    return false;
  }
  if (sourceSideBusy || targetTablesLoading) {
    return false;
  }
  if (syncAnalysisBusy) {
    return false;
  }
  return dataSyncEligibleTableCount > 0;
}, [
  tab,
  targetConfigured,
  sourceDb,
  targetDb,
  sourceSideBusy,
  targetTablesLoading,
  syncAnalysisBusy,
  dataSyncEligibleTableCount,
]);

const analyzeAllDisabledReason = useMemo(() => {
  if (tab !== "dataSync" || canAnalyzeAll) {
    return null;
  }
  if (!targetConfigured) {
    return t("database.toolbox.submitHintNoTarget");
  }
  if (sourceSelected.size === 0) {
    return t("database.toolbox.submitHintNoSelection");
  }
  if (!sourceDb.trim() || !targetDb.trim()) {
    return t("database.toolbox.submitHintNoDatabase");
  }
  if (sourceSideBusy || targetTablesLoading) {
    return t("database.toolbox.submitHintLoading");
  }
  if (syncAnalysisBusy) {
    return t("database.toolbox.submitHintBusy");
  }
  if (dataSyncEligibleTableCount === 0) {
    return t("database.toolbox.analyzeAllHintNoEligible");
  }
  return null;
}, [
  tab,
  canAnalyzeAll,
  targetConfigured,
  sourceSelected.size,
  sourceDb,
  targetDb,
  sourceSideBusy,
  targetTablesLoading,
  syncAnalysisBusy,
  dataSyncEligibleTableCount,
  t,
]);

const lastAnalysisTimeLabel = useMemo(
  () => (analysisAnalyzedAt !== null ? new Date(analysisAnalyzedAt).toLocaleString() : null),
  [analysisAnalyzedAt],
);


  return {
    handleBgTargetRowCount,
    handleBgTableAnalysis,
    handleBgSchemaDiff,
    handleBgAnalysisPending,
    handleBgTargetCounting,
    finalizeDataAnalysisTask,
    finalizeSchemaAnalysisTask,
    matchDbSyncBgTaskId,
    runBackgroundDataSync,
    handleViewConflictDetail,
    applyAnalysisCancelled,
    syncAnalysisBusy,
    schemaSyncBusy,
    hasSchemaAnalysisResult,
    hasDataAnalysisResult,
    prevDataAnalysisBusyRef,
    prevSchemaAnalysisBusyRef,
    handleSchemaAnalyze,
    runDataSyncAnalysis,
    handleDataAnalyze,
    handleAnalyzeTable,
    dataSyncAnalyzingTables,
    runAnalysisForTables,
    handlePostExecuteAnalyze,
    handleAnalyze,
    analyzeBusy,
    hasAnalysisResult,
    dataSyncEligibleTableCount,
    canAnalyzeAll,
    analyzeAllDisabledReason,
    lastAnalysisTimeLabel
  };
}
