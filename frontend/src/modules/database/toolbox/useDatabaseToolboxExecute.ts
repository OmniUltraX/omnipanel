import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { useCallback, useEffect, useMemo } from "react";
import {
  startDbDataSyncSqlExecute,
} from "./useDbSyncBackgroundTasks";
import {
  formatBackgroundTaskStatusMessage,
  useBackgroundTaskStore,
} from "../../../stores/backgroundTaskStore";
import {
  ignoredColumnsForTable,
  parseIgnoredFieldsInput,
} from "./ignoredFields";
import {
  type DbConnectionConfig,
} from "../api";
import type { SyncTaskSettings } from "./SyncTaskSettingsDialog";
import type { SyncTaskSqlPreviewInput } from "./syncTaskSqlPreview";
import {
  summarizeSqlPreviewInput,
  syncExecuteConfirmLog,
  syncExecuteConfirmWarn,
} from "./syncExecuteConfirmDebug";
import {
  filterSchemaSyncExecutableTableNames,
  isSchemaSyncTableExecutable,
} from "./schemaSyncAlignedTables";
import {
  type SchemaTableDiff,
} from "./schemaDiff";
import { useDbSyncTaskStore } from "../../../stores/dbSyncTaskStore";
import {
  type DataAnalysisResult,
  type DataSyncModes,
  type SyncSideSnapshot,
  type SchemaTableNameCase,
  type TableTargetStatus,
  type ToolboxTabId,
  type SchemaTargetRowStatus,
} from "./types";

export type UseDatabaseToolboxExecuteDeps = {
  active: boolean;
  addRunRecord: any;
  analysisAnalyzedAt: number | null;
  autoSavePausedRef: MutableRefObject<any>;
  autoSaveTimerRef: MutableRefObject<any>;
  bgDataTaskIdRef: MutableRefObject<any>;
  canPersistTask: boolean;
  canSaveTask: boolean;
  conflictDetailTable: string | null;
  connections: DbConnectionConfig[];
  executeConfirmSnapshot: SyncTaskSqlPreviewInput | null;
  executeTaskTablesRef: MutableRefObject<any>;
  expandedTablesKey: any;
  handlePostExecuteAnalyze: (tableNames?: string[]) => void;
  ignoredFields: string[];
  lockTablesForSync: (tableNames: string[]) => void;
  ownedDataExecuteTaskIdsRef: MutableRefObject<any>;
  pendingLoad: any;
  pendingPostExecuteAnalysisRef: MutableRefObject<any>;
  pendingPostExecuteTablesRef: MutableRefObject<any>;
  persistTask: any;
  postExecuteReanalysisTablesRef: MutableRefObject<any>;
  resolvedSchemaTableNameCase: SchemaTableNameCase;
  runAfterLoadRef: MutableRefObject<any>;
  schemaAnalysisDiffs: Record<string, SchemaTableDiff>;
  schemaAnalysisDiffsKey: any;
  schemaCaseSensitive: boolean;
  schemaCompareCaseSensitive: boolean;
  schemaCreateMissingTables: boolean;
  schemaDiffsForView: Record<string, SchemaTableDiff>;
  schemaSyncBusy: boolean;
  schemaTableSearch: string;
  schemaTargetStatusFilters: SchemaTargetRowStatus[];
  selectedTablesKey: any;
  setExecuteConfirmSnapshot: Dispatch<SetStateAction<SyncTaskSqlPreviewInput | null>>;
  setIgnoredFields: Dispatch<SetStateAction<string[]>>;
  setSchemaCaseSensitive: Dispatch<SetStateAction<boolean>>;
  setSchemaCreateMissingTables: Dispatch<SetStateAction<boolean>>;
  setSchemaTableNameCase: Dispatch<SetStateAction<SchemaTableNameCase>>;
  setSourceConnId: Dispatch<SetStateAction<string>>;
  setSourceDb: Dispatch<SetStateAction<string>>;
  setSourceDbs: Dispatch<SetStateAction<string[]>>;
  setSubmitNotice: Dispatch<SetStateAction<string | null>>;
  setSubmitting: Dispatch<SetStateAction<boolean>>;
  setSyncLockedTables: Dispatch<SetStateAction<Set<string>>>;
  setTargetConnId: Dispatch<SetStateAction<string>>;
  setTargetDb: Dispatch<SetStateAction<string>>;
  setTargetDbs: Dispatch<SetStateAction<string[]>>;
  setTaskName: Dispatch<SetStateAction<string>>;
  sourceConnId: string;
  sourceDb: string;
  sourceSelected: Set<string>;
  sourceSideBusy: boolean;
  sourceSnapshot: SyncSideSnapshot;
  sourceTableColumns: Record<string, import("../api").DbColumnMeta[]>;
  sourceTableIndexes: Record<string, import("../api").DbIndexMeta[]>;
  submitting: boolean;
  submittingTablesRef: MutableRefObject<any>;
  syncAnalysisBusy: boolean;
  syncLockedTables: Set<string>;
  syncTaskId: string;
  t: (key: string, params?: Record<string, string | number>) => string;
  tab: ToolboxTabId;
  tableAnalysis: Record<string, DataAnalysisResult>;
  tableAnalysisKey: any;
  tableSyncModes: Record<string, DataSyncModes>;
  tableSyncModesKey: any;
  tableTargetStatus: Record<string, TableTargetStatus>;
  targetConfigured: boolean;
  targetConnId: string;
  targetCountingTables: Set<string>;
  targetDb: string;
  targetRowCountsKey: any;
  targetSnapshot: SyncSideSnapshot;
  targetTablesLoading: boolean;
  taskLoadRef: MutableRefObject<any>;
  taskName: string;
  tryUnlockSyncTables: (runningSyncExecuteTables: Set<string>) => void;
};

export function useDatabaseToolboxExecute(deps: UseDatabaseToolboxExecuteDeps) {
  const {
    active,
    addRunRecord,
    analysisAnalyzedAt,
    autoSavePausedRef,
    autoSaveTimerRef,
    bgDataTaskIdRef,
    canPersistTask,
    canSaveTask,
    conflictDetailTable,
    connections,
    executeConfirmSnapshot,
    executeTaskTablesRef,
    expandedTablesKey,
    handlePostExecuteAnalyze,
    ignoredFields,
    lockTablesForSync,
    ownedDataExecuteTaskIdsRef,
    pendingLoad,
    pendingPostExecuteAnalysisRef,
    pendingPostExecuteTablesRef,
    persistTask,
    postExecuteReanalysisTablesRef,
    resolvedSchemaTableNameCase,
    runAfterLoadRef,
    schemaAnalysisDiffs,
    schemaAnalysisDiffsKey,
    schemaCaseSensitive,
    schemaCompareCaseSensitive,
    schemaCreateMissingTables,
    schemaDiffsForView,
    schemaSyncBusy,
    schemaTableSearch,
    schemaTargetStatusFilters,
    selectedTablesKey,
    setExecuteConfirmSnapshot,
    setIgnoredFields,
    setSchemaCaseSensitive,
    setSchemaCreateMissingTables,
    setSchemaTableNameCase,
    setSourceConnId,
    setSourceDb,
    setSourceDbs,
    setSubmitNotice,
    setSubmitting,
    setSyncLockedTables,
    setTargetConnId,
    setTargetDb,
    setTargetDbs,
    setTaskName,
    sourceConnId,
    sourceDb,
    sourceSelected,
    sourceSideBusy,
    sourceSnapshot,
    sourceTableColumns,
    sourceTableIndexes,
    submitting,
    submittingTablesRef,
    syncAnalysisBusy,
    syncLockedTables,
    syncTaskId,
    t,
    tab,
    tableAnalysis,
    tableAnalysisKey,
    tableSyncModes,
    tableSyncModesKey,
    tableTargetStatus,
    targetConfigured,
    targetConnId,
    targetCountingTables,
    targetDb,
    targetRowCountsKey,
    targetSnapshot,
    targetTablesLoading,
    taskLoadRef,
    taskName,
    tryUnlockSyncTables
  } = deps;

const canSubmit = useMemo(() => {
  if (sourceSelected.size === 0) return false;
  if (!targetConfigured || !sourceDb.trim() || !targetDb.trim()) return false;
  if (sourceSideBusy || targetSnapshot.loading) return false;
  if (tab === "dataSync") {
    if (syncAnalysisBusy || targetTablesLoading) return false;
    if (syncLockedTables.size > 0) return false;
    const selected = Array.from(sourceSelected);
    if (selected.some((name) => (sourceTableColumns[name] ?? []).length === 0)) {
      return false;
    }
    return true;
  }
  if (schemaSyncBusy) return false;
  const selected = Array.from(sourceSelected);
  return selected.some((name) =>
    isSchemaSyncTableExecutable(
      name,
      schemaDiffsForView,
      targetSnapshot.tables,
      schemaCompareCaseSensitive,
      schemaCreateMissingTables,
    ),
  );
}, [
  sourceSelected.size,
  targetConfigured,
  sourceDb,
  targetDb,
  tab,
  syncAnalysisBusy,
  schemaSyncBusy,
  sourceSideBusy,
  targetSnapshot.loading,
  targetTablesLoading,
  sourceSelected,
  sourceTableColumns,
  syncLockedTables.size,
  schemaDiffsForView,
  targetSnapshot.tables,
  schemaCompareCaseSensitive,
  schemaCreateMissingTables,
]);

const submitDisabledReason = useMemo(() => {
  if (sourceSelected.size === 0) return t("database.toolbox.submitHintNoSelection");
  if (!targetConfigured) return t("database.toolbox.submitHintNoTarget");
  if (!sourceDb.trim() || !targetDb.trim()) return t("database.toolbox.submitHintNoDatabase");
  if (sourceSideBusy || targetSnapshot.loading) {
    return t("database.toolbox.submitHintLoading");
  }
  if (tab === "dataSync") {
    if (targetTablesLoading) return t("database.toolbox.submitHintLoading");
    if (syncLockedTables.size > 0) return t("database.toolbox.submitHintSyncRunning");
    if (syncAnalysisBusy) return t("database.toolbox.submitHintBusy");
    const missingColumns = Array.from(sourceSelected).some(
      (name) => (sourceTableColumns[name] ?? []).length === 0,
    );
    if (missingColumns) return t("database.toolbox.submitHintMissingColumns");
  }
  if (tab === "schemaSync" && schemaSyncBusy) return t("database.toolbox.submitHintBusy");
  if (tab === "schemaSync") {
    const selected = Array.from(sourceSelected);
    const executable = filterSchemaSyncExecutableTableNames(
      selected,
      schemaDiffsForView,
      targetSnapshot.tables,
      schemaCompareCaseSensitive,
      schemaCreateMissingTables,
    );
    if (executable.length === 0) {
      return t("database.toolbox.submitHintSchemaNoChanges");
    }
  }
  return null;
}, [
  sourceSelected,
  targetConfigured,
  sourceDb,
  targetDb,
  tab,
  syncAnalysisBusy,
  schemaSyncBusy,
  sourceSideBusy,
  targetSnapshot.loading,
  targetTablesLoading,
  sourceTableColumns,
  syncLockedTables.size,
  schemaDiffsForView,
  targetSnapshot.tables,
  schemaCompareCaseSensitive,
  schemaCreateMissingTables,
  t,
]);

const backgroundTasks = useBackgroundTaskStore((s) => s.tasks);

const runningSyncExecuteTables = useMemo(() => {
  const names = new Set<string>();
  if (tab !== "dataSync") {
    return names;
  }
  const runs = useDbSyncTaskStore.getState().runHistory[syncTaskId] ?? [];
  for (const task of Object.values(backgroundTasks)) {
    if (task.kind !== "dbDataSyncExecute") {
      continue;
    }
    if (task.status !== "pending" && task.status !== "running") {
      continue;
    }
    const run = runs.find((item) => item.bgTaskId === task.id && item.kind === tab);
    for (const name of run?.tableNames ?? []) {
      names.add(name);
    }
  }
  return names;
}, [backgroundTasks, syncTaskId, tab]);

useEffect(() => {
  if (!active || !pendingPostExecuteAnalysisRef.current) {
    return;
  }
  if (taskLoadRef.current || sourceSideBusy || targetSnapshot.loading) {
    return;
  }
  if (tab === "dataSync" && targetTablesLoading) {
    return;
  }
  if (runningSyncExecuteTables.size > 0) {
    return;
  }
  const analysisTaskId = bgDataTaskIdRef.current;
  if (analysisTaskId) {
    const analysisTask = backgroundTasks[analysisTaskId];
    if (
      analysisTask &&
      (analysisTask.status === "pending" || analysisTask.status === "running")
    ) {
      return;
    }
  }
  pendingPostExecuteAnalysisRef.current = false;
  const tables = pendingPostExecuteTablesRef.current;
  pendingPostExecuteTablesRef.current = [];
  handlePostExecuteAnalyze(tables.length > 0 ? tables : undefined);
}, [
  active,
  tab,
  sourceSideBusy,
  targetSnapshot.loading,
  targetTablesLoading,
  handlePostExecuteAnalyze,
  runningSyncExecuteTables,
  backgroundTasks,
]);

useEffect(() => {
  tryUnlockSyncTables(runningSyncExecuteTables);
}, [tableAnalysis, runningSyncExecuteTables, tryUnlockSyncTables]);

useEffect(() => {
  setSyncLockedTables(new Set());
  postExecuteReanalysisTablesRef.current.clear();
  ownedDataExecuteTaskIdsRef.current.clear();
}, [syncTaskId]);

useEffect(() => {
  if (tab !== "dataSync") {
    return;
  }
  const runs = useDbSyncTaskStore.getState().runHistory[syncTaskId] ?? [];
  const locked = new Set<string>();
  for (const task of Object.values(backgroundTasks)) {
    if (task.kind !== "dbDataSyncExecute") {
      continue;
    }
    if (task.status !== "pending" && task.status !== "running") {
      continue;
    }
    const run = runs.find((item) => item.bgTaskId === task.id && item.kind === tab);
    for (const name of run?.tableNames ?? []) {
      locked.add(name);
    }
  }
  if (locked.size === 0) {
    return;
  }
  setSyncLockedTables((prev) => {
    const next = new Set(prev);
    for (const name of locked) {
      next.add(name);
    }
    return next.size === prev.size ? prev : next;
  });
}, [backgroundTasks, syncTaskId, tab]);

const activeDataSyncBgTask = useMemo(() => {
  if (tab !== "dataSync") {
    return null;
  }
  const running = Object.values(backgroundTasks).filter(
    (task) =>
      (task.kind === "dbDataSyncExecute" || task.kind === "dbDataSyncAnalysis") &&
      (task.status === "pending" || task.status === "running"),
  );
  return (
    running.find((task) => task.kind === "dbDataSyncExecute") ??
    running.find((task) => task.kind === "dbDataSyncAnalysis") ??
    null
  );
}, [backgroundTasks, tab]);

const dataSyncProgressLabel = useMemo(() => {
  if (!activeDataSyncBgTask) {
    return null;
  }
  return formatBackgroundTaskStatusMessage(activeDataSyncBgTask, 1, t);
}, [activeDataSyncBgTask, t]);

const conflictDetailIgnoredColumns = useMemo(() => {
  if (!conflictDetailTable) {
    return new Set<string>();
  }
  return ignoredColumnsForTable(conflictDetailTable, ignoredFields);
}, [conflictDetailTable, ignoredFields]);

const sourceRowCountsForPreview = useMemo(() => {
  const counts: Record<string, number | null> = {};
  for (const table of sourceSnapshot.tables) {
    counts[table.name] = table.rowCount;
  }
  return counts;
}, [sourceSnapshot.tables]);

const buildSqlPreviewInput = useCallback(
  (tableNames: string[]): SyncTaskSqlPreviewInput | null => {
    const sourceConn = connections.find((c) => c.id === sourceConnId);
    const targetConn = connections.find((c) => c.id === targetConnId);
    if (!sourceConn || !targetConn || !sourceDb.trim() || !targetDb.trim()) {
      syncExecuteConfirmWarn("buildInput:missing-connection-or-db", {
        tableNames,
        sourceConnId,
        targetConnId,
        hasSourceConn: Boolean(sourceConn),
        hasTargetConn: Boolean(targetConn),
        sourceDb: sourceDb.trim() || null,
        targetDb: targetDb.trim() || null,
      });
      return null;
    }
    const names = [...tableNames].sort((a, b) => a.localeCompare(b));
    if (names.length === 0) {
      syncExecuteConfirmWarn("buildInput:empty-table-names");
      return null;
    }
    const input = {
      tab,
      sourceConn,
      sourceDb,
      targetConn,
      targetDb,
      tableNames: names,
      tableTargetStatus,
      tableSyncModes,
      sourceTableColumns,
      sourceTableIndexes,
      schemaAnalysisDiffs: tab === "schemaSync" ? schemaDiffsForView : schemaAnalysisDiffs,
      sourceRowCounts: sourceRowCountsForPreview,
      targetTables: targetSnapshot.tables,
      schemaCaseSensitive: schemaCompareCaseSensitive,
      schemaTableNameCase: resolvedSchemaTableNameCase,
      schemaCreateMissingTables,
      tableAnalysis: tab === "dataSync" ? tableAnalysis : undefined,
    };
    syncExecuteConfirmLog("buildInput:ok", summarizeSqlPreviewInput(input));
    return input;
  },
  [
    connections,
    sourceConnId,
    targetConnId,
    sourceDb,
    targetDb,
    tab,
    tableTargetStatus,
    tableSyncModes,
    sourceTableColumns,
    sourceTableIndexes,
    schemaAnalysisDiffs,
    schemaDiffsForView,
    sourceRowCountsForPreview,
    targetSnapshot.tables,
    schemaCompareCaseSensitive,
    resolvedSchemaTableNameCase,
    schemaCreateMissingTables,
    tableAnalysis,
  ],
);

const scriptPreviewInput = useMemo((): SyncTaskSqlPreviewInput | null => {
  const selected = Array.from(sourceSelected);
  const names =
    tab === "schemaSync"
      ? filterSchemaSyncExecutableTableNames(
          selected,
          schemaDiffsForView,
          targetSnapshot.tables,
          schemaCompareCaseSensitive,
          schemaCreateMissingTables,
        )
      : selected;
  return buildSqlPreviewInput(names);
}, [
  buildSqlPreviewInput,
  sourceSelected,
  tab,
  schemaDiffsForView,
  targetSnapshot.tables,
  schemaCompareCaseSensitive,
  schemaCreateMissingTables,
]);

const executeConfirmTitle = useMemo(() => {
  if (!executeConfirmSnapshot) {
    return t("database.toolbox.executeConfirmTitle");
  }
  if (executeConfirmSnapshot.tableNames.length === 1) {
    return t("database.toolbox.executeConfirmTitleTable", {
      table: executeConfirmSnapshot.tableNames[0],
    });
  }
  return t("database.toolbox.executeConfirmTitleBatch", {
    count: executeConfirmSnapshot.tableNames.length,
  });
}, [executeConfirmSnapshot, t]);

const openExecuteConfirmDialog = useCallback(
  (tableNames: string[]) => {
    syncExecuteConfirmLog("openDialog:click", { tableNames });
    const input = buildSqlPreviewInput(tableNames);
    if (!input) {
      syncExecuteConfirmWarn("openDialog:blocked-no-input", { tableNames });
      setSubmitNotice(t("database.toolbox.submitHintNoDatabase"));
      return;
    }
    syncExecuteConfirmLog("openDialog:snapshot", summarizeSqlPreviewInput(input));
    setExecuteConfirmSnapshot(input);
  },
  [buildSqlPreviewInput, t],
);

const closeExecuteConfirmDialog = useCallback(() => {
  setExecuteConfirmSnapshot(null);
}, []);

useEffect(() => {
  if (!active || !canPersistTask) {
    return;
  }
  if (autoSavePausedRef.current || taskLoadRef.current || pendingLoad) {
    return;
  }

  if (autoSaveTimerRef.current) {
    clearTimeout(autoSaveTimerRef.current);
  }
  autoSaveTimerRef.current = setTimeout(() => {
    autoSaveTimerRef.current = null;
    if (autoSavePausedRef.current || taskLoadRef.current) {
      return;
    }
    persistTask();
  }, 400);

  return () => {
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
  };
}, [
  active,
  canPersistTask,
  pendingLoad,
  tab,
  taskName,
  sourceConnId,
  sourceDb,
  targetConnId,
  targetDb,
  selectedTablesKey,
  expandedTablesKey,
  tableSyncModesKey,
  schemaCaseSensitive,
  schemaTargetStatusFilters,
  schemaTableSearch,
  analysisAnalyzedAt,
  schemaAnalysisDiffsKey,
  tableAnalysisKey,
  targetRowCountsKey,
  persistTask,
]);

/** 切换离开当前 Panel 时立即落盘，避免防抖未触发导致丢失 */
useEffect(() => {
  if (active || !canPersistTask) {
    return;
  }
  if (autoSavePausedRef.current || taskLoadRef.current || pendingLoad) {
    return;
  }
  if (autoSaveTimerRef.current) {
    clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = null;
  }
  persistTask();
}, [active, canPersistTask, pendingLoad, persistTask]);

const ensureTaskIdForRun = useCallback((): string | null => {
  if (syncTaskId) {
    return syncTaskId;
  }
  if (!canSaveTask) {
    return null;
  }
  persistTask();
  return syncTaskId;
}, [syncTaskId, canSaveTask, persistTask]);

const recordSyncTaskRun = useCallback(
  (tableNames: string[], bgTaskId: string) => {
    const taskId = ensureTaskIdForRun();
    if (!taskId) {
      return;
    }
    addRunRecord(taskId, {
      id: `sync-run:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      bgTaskId,
      kind: tab,
      status: "pending",
      tableCount: tableNames.length,
      tableNames,
      startedAt: Date.now(),
    });
  },
  [ensureTaskIdForRun, addRunRecord, tab],
);

const handleApplyTaskSettings = useCallback((settings: SyncTaskSettings) => {
  setTaskName(settings.taskName);
  setSchemaCaseSensitive(settings.schemaCaseSensitive);
  setSchemaTableNameCase(settings.schemaTableNameCase);
  setSchemaCreateMissingTables(settings.schemaCreateMissingTables);
  if (tab === "dataSync") {
    setIgnoredFields(parseIgnoredFieldsInput(settings.ignoredFieldsText));
  }
}, [tab]);

const canSubmitTable = useCallback(
  (tableName: string) => {
    if (!sourceSelected.has(tableName)) {
      return false;
    }
    if (syncLockedTables.has(tableName)) {
      return false;
    }
    if (!targetConfigured || !sourceDb.trim() || !targetDb.trim()) {
      return false;
    }
    if (sourceSideBusy || targetSnapshot.loading || targetTablesLoading) {
      return false;
    }
    if ((sourceTableColumns[tableName] ?? []).length === 0) {
      return false;
    }
    if (tableAnalysis[tableName]?.status === "analyzing") {
      return false;
    }
    if (tab === "dataSync") {
      const analysis = tableAnalysis[tableName];
      if (
        !analysis ||
        analysis.status === "unchecked" ||
        analysis.status === "analyzing" ||
        analysis.status === "error"
      ) {
        return false;
      }
      if (analysis.status === "diff" && !analysis.diffCacheId) {
        return false;
      }
    }
    if (tab === "schemaSync") {
      if (
        !isSchemaSyncTableExecutable(
          tableName,
          schemaDiffsForView,
          targetSnapshot.tables,
          schemaCompareCaseSensitive,
          schemaCreateMissingTables,
        )
      ) {
        return false;
      }
    }
    if (targetCountingTables.has(tableName)) {
      return false;
    }
    return true;
  },
  [
    sourceSelected,
    syncLockedTables,
    targetConfigured,
    sourceDb,
    targetDb,
    sourceSideBusy,
    targetSnapshot.loading,
    targetTablesLoading,
    sourceTableColumns,
    tableAnalysis,
    targetCountingTables,
    tab,
    schemaDiffsForView,
    targetSnapshot.tables,
    schemaCompareCaseSensitive,
    schemaCreateMissingTables,
  ],
);

const executeConfirmedTables = useCallback(
  async (tableNames: string[], sqlFilePath: string) => {
    if (tableNames.length === 0) {
      return;
    }

    const targetConn = connections.find((c) => c.id === targetConnId);
    if (!targetConn) {
      return;
    }
    if (!sqlFilePath.trim()) {
      setSubmitNotice(t("database.toolbox.executeConfirmMissingSqlFile"));
      return;
    }

    setSubmitting(true);
    setSubmitNotice(null);

    try {
      if (tab === "dataSync") {
        lockTablesForSync(tableNames);
        for (const name of tableNames) {
          submittingTablesRef.current.add(name);
        }
      }
      const bgTaskId = await startDbDataSyncSqlExecute(
        targetConn,
        targetDb,
        sqlFilePath,
        tableNames,
      );
      executeTaskTablesRef.current.set(bgTaskId, tableNames);
      if (tab === "dataSync") {
        ownedDataExecuteTaskIdsRef.current.add(bgTaskId);
      }
      recordSyncTaskRun(tableNames, bgTaskId);
      void useBackgroundTaskStore.getState().refreshRunning();
      setSubmitNotice(t("database.toolbox.submitSuccess"));
    } catch (error) {
      if (tab === "dataSync") {
        for (const name of tableNames) {
          postExecuteReanalysisTablesRef.current.delete(name);
        }
        setSyncLockedTables((prev) => {
          const next = new Set(prev);
          for (const name of tableNames) {
            next.delete(name);
          }
          return next.size === prev.size ? prev : next;
        });
      }
      setSubmitNotice(String(error));
    } finally {
      setSubmitting(false);
      if (tab === "dataSync") {
        for (const name of tableNames) {
          submittingTablesRef.current.delete(name);
        }
      }
    }
  },
  [
    connections,
    targetConnId,
    targetDb,
    tab,
    lockTablesForSync,
    recordSyncTaskRun,
    t,
  ],
);

const handleExecuteConfirm = useCallback(
  (sqlFilePath: string) => {
    if (!executeConfirmSnapshot) {
      return;
    }
    const tableNames = executeConfirmSnapshot.tableNames;
    setExecuteConfirmSnapshot(null);
    void executeConfirmedTables(tableNames, sqlFilePath);
  },
  [executeConfirmSnapshot, executeConfirmedTables],
);

const handleSingleTableSubmit = useCallback(
  (tableName: string) => {
    if (!canSubmitTable(tableName)) {
      syncExecuteConfirmWarn("singleSubmit:blocked-canSubmit", { tableName });
      return;
    }
    if (submitting) {
      syncExecuteConfirmWarn("singleSubmit:blocked-submitting", { tableName });
      return;
    }
    if (executeConfirmSnapshot) {
      syncExecuteConfirmWarn("singleSubmit:blocked-dialog-open", {
        tableName,
        pendingTables: executeConfirmSnapshot.tableNames,
      });
      return;
    }
    syncExecuteConfirmLog("singleSubmit:proceed", {
      tableName,
      syncModes: tableSyncModes[tableName] ?? null,
      targetStatus: tableTargetStatus[tableName] ?? null,
    });
    if (canSaveTask) {
      persistTask();
    }
    openExecuteConfirmDialog([tableName]);
  },
  [
    canSubmitTable,
    submitting,
    executeConfirmSnapshot,
    canSaveTask,
    persistTask,
    openExecuteConfirmDialog,
    tableSyncModes,
    tableTargetStatus,
  ],
);

const handleSubmit = useCallback(async (): Promise<boolean> => {
  if (!canSubmit || submitting || executeConfirmSnapshot) {
    return false;
  }

  const tableNames = Array.from(sourceSelected).sort((a, b) => a.localeCompare(b));
  let namesToRun = tableNames;

  if (tab === "schemaSync") {
    namesToRun = filterSchemaSyncExecutableTableNames(
      tableNames,
      schemaDiffsForView,
      targetSnapshot.tables,
      schemaCompareCaseSensitive,
      schemaCreateMissingTables,
    );
    if (namesToRun.length === 0) {
      setSubmitNotice(t("database.toolbox.submitHintSchemaNoChanges"));
      return false;
    }
  }

  if (canSaveTask) {
    persistTask();
  }
  openExecuteConfirmDialog(namesToRun);
  return false;
}, [
  canSubmit,
  submitting,
  executeConfirmSnapshot,
  sourceSelected,
  tab,
  schemaCreateMissingTables,
  schemaCompareCaseSensitive,
  schemaDiffsForView,
  targetSnapshot.tables,
  canSaveTask,
  persistTask,
  openExecuteConfirmDialog,
  t,
]);

useEffect(() => {
  if (!runAfterLoadRef.current || !canSubmit || submitting) {
    return;
  }
  runAfterLoadRef.current = false;
  void handleSubmit();
}, [canSubmit, submitting, handleSubmit]);

const handleSourceConnectionChange = useCallback((connId: string) => {
  if (connId === sourceConnId) {
    return;
  }
  setSourceConnId(connId);
  setSourceDb("");
  setSourceDbs([]);
}, [sourceConnId]);

const handleTargetConnectionChange = useCallback((connId: string) => {
  if (connId === targetConnId) {
    return;
  }
  setTargetConnId(connId);
  setTargetDb("");
  setTargetDbs([]);
}, [targetConnId]);

  return {
    canSubmit,
    submitDisabledReason,
    backgroundTasks,
    runningSyncExecuteTables,
    activeDataSyncBgTask,
    dataSyncProgressLabel,
    conflictDetailIgnoredColumns,
    sourceRowCountsForPreview,
    buildSqlPreviewInput,
    scriptPreviewInput,
    executeConfirmTitle,
    openExecuteConfirmDialog,
    closeExecuteConfirmDialog,
    ensureTaskIdForRun,
    recordSyncTaskRun,
    handleApplyTaskSettings,
    canSubmitTable,
    executeConfirmedTables,
    handleExecuteConfirm,
    handleSingleTableSubmit,
    handleSubmit,
    handleSourceConnectionChange,
    handleTargetConnectionChange
  };
}
