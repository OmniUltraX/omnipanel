import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../../i18n";
import { useDataLoading } from "../../../components/ui/DataLoading";
import { useDbSyncTaskStore } from "../../../stores/dbSyncTaskStore";
import {
  isSchemaCaseSensitive,
  resolveSchemaTableNameCase,
} from "./schemaSyncAlignedTables";
import { buildSyncAnalysisConfigKey } from "./syncTaskAnalysisCache";
import type {
  DataAnalysisResult,
  DataSyncModes,
  SchemaTableNameCase,
  SchemaTargetRowStatus,
  SyncSideSnapshot,
  SyncTaskConfig,
  TableTargetStatus,
} from "./types";
import type { SchemaTableDiff } from "./schemaDiff";
import type { SyncTaskSqlPreviewInput } from "./syncTaskSqlPreview";
import { EMPTY_SNAPSHOT } from "./databaseToolboxConstants";
import type { DatabaseToolboxProps } from "./databaseToolboxTypes";
import { useDatabaseToolboxConnections } from "./useDatabaseToolboxConnections";
import { useDatabaseToolboxBgAnalysis } from "./useDatabaseToolboxBgAnalysis";
import { useDatabaseToolboxTaskLifecycle } from "./useDatabaseToolboxTaskLifecycle";
import { useDatabaseToolboxExecute } from "./useDatabaseToolboxExecute";

export function useDatabaseToolboxModel({
  connections,
  tab,
  syncTaskId,
  initialSourceConnectionId,
  initialSourceDatabase = "",
  active = true,
}: DatabaseToolboxProps) {
const { t } = useI18n();
const {
  total: loadTotal,
  current: loadCurrent,
  message: loadMessage,
  reset: resetLoadProgress,
  advance: advanceLoadProgress,
} = useDataLoading();

const [sourceConnId, setSourceConnId] = useState("");
const [sourceDb, setSourceDb] = useState("");
const [targetConnId, setTargetConnId] = useState("");
const [targetDb, setTargetDb] = useState("");

const [sourceDbs, setSourceDbs] = useState<string[]>([]);
const [targetDbs, setTargetDbs] = useState<string[]>([]);
const [sourceDbsLoading, setSourceDbsLoading] = useState(false);
const [targetDbsLoading, setTargetDbsLoading] = useState(false);

const [sourceSnapshot, setSourceSnapshot] = useState<SyncSideSnapshot>(EMPTY_SNAPSHOT);
const [sourceCatalogNames, setSourceCatalogNames] = useState<string[]>([]);
const [sourceCatalogLoading, setSourceCatalogLoading] = useState(false);
const [sourceCatalogError, setSourceCatalogError] = useState<string | null>(null);
const [sourceAddingTables, setSourceAddingTables] = useState(false);
const sourceSideBusy =
  sourceSnapshot.loading || sourceCatalogLoading || sourceAddingTables;
const [targetSnapshot, setTargetSnapshot] = useState<SyncSideSnapshot>(EMPTY_SNAPSHOT);

const [targetTableNames, setTargetTableNames] = useState<Set<string>>(() => new Set());
const [targetTablesLoading, setTargetTablesLoading] = useState(false);

const [sourceExpanded, setSourceExpanded] = useState<Set<string>>(() => new Set());
const [schemaCaseSensitive, setSchemaCaseSensitive] = useState(true);
const [schemaTableNameCase, setSchemaTableNameCase] = useState<SchemaTableNameCase>("lower");
const [schemaCreateMissingTables, setSchemaCreateMissingTables] = useState(true);
const [schemaTargetStatusFilters, setSchemaTargetStatusFilters] = useState<
  SchemaTargetRowStatus[]
>([]);
const [schemaTableSearch, setSchemaTableSearch] = useState("");
const [ignoredFields, setIgnoredFields] = useState<string[]>([]);
const sourceListRef = useRef<HTMLDivElement>(null);
const targetListRef = useRef<HTMLDivElement>(null);
const scrollSyncLockRef = useRef(false);
const autoSavePausedRef = useRef(false);
const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
const [sourceSelected, setSourceSelected] = useState<Set<string>>(() => new Set());
const [sourceListHighlight, setSourceListHighlight] = useState<Set<string>>(() => new Set());
const [tableTargetStatus, setTableTargetStatus] = useState<Record<string, TableTargetStatus>>({});
const [tableSyncModes, setTableSyncModes] = useState<Record<string, DataSyncModes>>({});
const [tableAnalysis, setTableAnalysis] = useState<Record<string, DataAnalysisResult>>({});
const [conflictDetailTable, setConflictDetailTable] = useState<string | null>(null);
const [submitting, setSubmitting] = useState(false);
const [syncLockedTables, setSyncLockedTables] = useState<Set<string>>(() => new Set());
const [submitNotice, setSubmitNotice] = useState<string | null>(null);
const [taskSettingsOpen, setTaskSettingsOpen] = useState(false);
const [taskHistoryOpen, setTaskHistoryOpen] = useState(false);
const [taskScriptPreviewOpen, setTaskScriptPreviewOpen] = useState(false);
const [executeConfirmSnapshot, setExecuteConfirmSnapshot] =
  useState<SyncTaskSqlPreviewInput | null>(null);
const [taskName, setTaskName] = useState("");
const analyzingRef = useRef(new Set<string>());
/** 递增后使进行中的统计/比对任务全部失效 */
const syncRunIdRef = useRef(0);
const tableAnalysisRef = useRef(tableAnalysis);
tableAnalysisRef.current = tableAnalysis;

const countingRef = useRef(new Set<string>());
const [countingTables, setCountingTables] = useState<Set<string>>(() => new Set());
const targetCountingRef = useRef(new Set<string>());
const [targetCountingTables, setTargetCountingTables] = useState<Set<string>>(() => new Set());
const [targetRowCounts, setTargetRowCounts] = useState<Record<string, number | null>>({});

const schemaFetchingRef = useRef(new Set<string>());
const [schemaTableDiffs, setSchemaTableDiffs] = useState<Record<string, SchemaTableDiff>>({});
const schemaTableDiffsRef = useRef(schemaTableDiffs);
schemaTableDiffsRef.current = schemaTableDiffs;
const [schemaAnalysisDiffs, setSchemaAnalysisDiffs] = useState<Record<string, SchemaTableDiff>>({});
const [analysisAnalyzedAt, setAnalysisAnalyzedAt] = useState<number | null>(null);
const [schemaAnalyzing, setSchemaAnalyzing] = useState(false);
const lastAnalysisConfigKeyRef = useRef("");
const analysisAnalyzedAtRef = useRef<number | null>(null);
const lastAnalyzedSelectionRef = useRef<Set<string>>(new Set());
const bgDataTaskIdRef = useRef<string | null>(null);
const ownedDataAnalysisTaskIdsRef = useRef(new Set<string>());
const ownedDataExecuteTaskIdsRef = useRef(new Set<string>());
const ownedSchemaAnalysisTaskIdsRef = useRef(new Set<string>());
const executeTaskTablesRef = useRef(new Map<string, string[]>());
const submittingTablesRef = useRef(new Set<string>());
const dataAnalysisBatchByTaskRef = useRef(new Map<string, string[]>());
const schemaAnalysisBatchByTaskRef = useRef(new Map<string, string[]>());
/** await 拿到 taskId 之前的事件窗口；仅匹配 batch 内表名，避免误收其它 Panel 事件 */
const analysisPendingBatchRef = useRef<string[] | null>(null);
const schemaAnalysisPendingBatchRef = useRef<string[] | null>(null);
const bgSchemaTaskIdRef = useRef<string | null>(null);
const dataAnalysisStartedAtRef = useRef<number | null>(null);
const schemaAnalysisStartedAtRef = useRef<number | null>(null);

const pendingLoad = useDbSyncTaskStore((s) => s.pendingLoad);
const syncTasks = useDbSyncTaskStore((s) => s.tasks);
const clearPendingLoad = useDbSyncTaskStore((s) => s.clearPendingLoad);
const setActiveTaskId = useDbSyncTaskStore((s) => s.setActiveTaskId);
const updateSyncTask = useDbSyncTaskStore((s) => s.updateTask);
const addRunRecord = useDbSyncTaskStore((s) => s.addRunRecord);
const addAnalysisRecord = useDbSyncTaskStore((s) => s.addAnalysisRecord);

/** 从侧栏加载任务时的分阶段配置 */
const taskLoadRef = useRef<{ config: SyncTaskConfig; runAfterLoad: boolean } | null>(null);
const runAfterLoadRef = useRef(false);
const taskLoadAppliedRef = useRef(false);
const taskInitializedRef = useRef(false);
const lastPendingLoadNonceRef = useRef(0);
const loadedForSyncTaskRef = useRef<string | null>(null);
const prevSyncTaskIdForLoadRef = useRef<string | undefined>(undefined);
const prevSourceConnIdRef = useRef<string | null>(null);
const prevTargetConnIdRef = useRef<string | null>(null);
const prevSourceSideKeyRef = useRef<string | null>(null);
const pendingAddedTablesRef = useRef<string[] | null>(null);
const addSourceTablesRunRef = useRef(0);
const sourceCatalogNamesRef = useRef(sourceCatalogNames);
sourceCatalogNamesRef.current = sourceCatalogNames;
const sourceSnapshotTablesRef = useRef(sourceSnapshot.tables);
sourceSnapshotTablesRef.current = sourceSnapshot.tables;
const prevTargetSideKeyRef = useRef<string | null>(null);
const cachedAnalysisLoadedKeyRef = useRef<string | null>(null);

const activeRef = useRef(active);
activeRef.current = active;
const pendingPostExecuteAnalysisRef = useRef(false);
const pendingPostExecuteTablesRef = useRef<string[]>([]);
const postExecuteReanalysisTablesRef = useRef(new Set<string>());
const handlePostExecuteAnalyzeRef = useRef<(tableNames?: string[]) => void>(() => {});

const targetConfigured = Boolean(targetConnId && targetDb.trim());
const schemaCompareCaseSensitive = isSchemaCaseSensitive(schemaCaseSensitive);
const resolvedSchemaTableNameCase = resolveSchemaTableNameCase(schemaTableNameCase);

useEffect(() => {
  analysisAnalyzedAtRef.current = analysisAnalyzedAt;
}, [analysisAnalyzedAt]);

const analysisConfigKey = useMemo(
  () =>
    buildSyncAnalysisConfigKey({
      tab,
      sourceConnId,
      sourceDb,
      targetConnId,
      targetDb,
      schemaCaseSensitive,
      schemaTableNameCase: resolvedSchemaTableNameCase,
      schemaCreateMissingTables,
      ignoredFields: tab === "dataSync" ? ignoredFields : undefined,
    }),
  [
    tab,
    sourceConnId,
    sourceDb,
    targetConnId,
    targetDb,
    schemaCaseSensitive,
    resolvedSchemaTableNameCase,
    schemaCreateMissingTables,
    ignoredFields,
  ],
);

/** 配置指纹变化时尝试恢复上次分析结果 */
const prevAnalysisConfigKeyRef = useRef<string | null>(null);


  const connectionsApi = useDatabaseToolboxConnections({
    active,
    addSourceTablesRunRef,
    advanceLoadProgress,
    analysisAnalyzedAtRef,
    analyzingRef,
    cachedAnalysisLoadedKeyRef,
    connections,
    countingRef,
    ignoredFields,
    initialSourceConnectionId,
    initialSourceDatabase,
    lastAnalysisConfigKeyRef,
    lastAnalyzedSelectionRef,
    pendingAddedTablesRef,
    postExecuteReanalysisTablesRef,
    prevSourceConnIdRef,
    prevSourceSideKeyRef,
    prevTargetConnIdRef,
    prevTargetSideKeyRef,
    resetLoadProgress,
    schemaAnalysisDiffs,
    schemaAnalyzing,
    schemaCompareCaseSensitive,
    schemaFetchingRef,
    schemaTableDiffs,
    schemaTableSearch,
    schemaTargetStatusFilters,
    scrollSyncLockRef,
    setAnalysisAnalyzedAt,
    setConflictDetailTable,
    setCountingTables,
    setSchemaAnalysisDiffs,
    setSchemaTableDiffs,
    setSchemaTableSearch,
    setSourceAddingTables,
    setSourceCatalogError,
    setSourceCatalogLoading,
    setSourceCatalogNames,
    setSourceConnId,
    setSourceDb,
    setSourceDbs,
    setSourceDbsLoading,
    setSourceExpanded,
    setSourceListHighlight,
    setSourceSelected,
    setSourceSnapshot,
    setSubmitNotice,
    setSyncLockedTables,
    setTableAnalysis,
    setTableSyncModes,
    setTableTargetStatus,
    setTargetConnId,
    setTargetCountingTables,
    setTargetDb,
    setTargetDbs,
    setTargetDbsLoading,
    setTargetRowCounts,
    setTargetSnapshot,
    setTargetTableNames,
    setTargetTablesLoading,
    sourceAddingTables,
    sourceCatalogLoading,
    sourceCatalogNamesRef,
    sourceConnId,
    sourceDb,
    sourceDbs,
    sourceListRef,
    sourceSelected,
    sourceSideBusy,
    sourceSnapshot,
    sourceSnapshotTablesRef,
    syncRunIdRef,
    syncTaskId,
    t,
    tab,
    tableAnalysis,
    tableAnalysisRef,
    targetConfigured,
    targetConnId,
    targetCountingRef,
    targetDb,
    targetDbs,
    targetListRef,
    targetRowCounts,
    targetSnapshot,
    targetTableNames,
    targetTablesLoading,
    taskLoadRef,
  });
  const {
    restoreAnalysisFromConfig,
    clearAnalysisState,
    loadDatabases,
    loadTargetSnapshot,
    removeSourceTables,
    syncSourceTableSelection,
    loadDataForCachedAnalysis,
    toggleSourceTable,
    toggleSourceSelected,
    handleSourceSelectAll,
    setTableSyncMode,
    lockTablesForSync,
    tryUnlockSyncTables,
    sourceSelectedTableNames,
    sourceTableColumns,
    sourceTableIndexes,
    schemaTargetKey,
    sourceTableNameSet,
    schemaDiffsForView,
    visibleSchemaAlignedTableNames,
  } = connectionsApi;

  const bgApi = useDatabaseToolboxBgAnalysis({
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
    taskLoadRef,
  });
  const {
    handleViewConflictDetail,
    syncAnalysisBusy,
    schemaSyncBusy,
    hasDataAnalysisResult,
    handleDataAnalyze,
    handleAnalyzeTable,
    dataSyncAnalyzingTables,
    handlePostExecuteAnalyze,
    handleAnalyze,
    analyzeBusy,
    hasAnalysisResult,
    canAnalyzeAll,
    analyzeAllDisabledReason,
    lastAnalysisTimeLabel,
  } = bgApi;

  const lifeApi = useDatabaseToolboxTaskLifecycle({
    active,
    analysisAnalyzedAt,
    analysisConfigKey,
    analyzingRef,
    autoSavePausedRef,
    cachedAnalysisLoadedKeyRef,
    clearAnalysisState,
    clearPendingLoad,
    connections,
    countingRef,
    ignoredFields,
    lastAnalysisConfigKeyRef,
    lastAnalyzedSelectionRef,
    lastPendingLoadNonceRef,
    loadDataForCachedAnalysis,
    loadDatabases,
    loadedForSyncTaskRef,
    pendingAddedTablesRef,
    pendingLoad,
    prevAnalysisConfigKeyRef,
    prevSourceConnIdRef,
    prevSourceSideKeyRef,
    prevSyncTaskIdForLoadRef,
    prevTargetConnIdRef,
    prevTargetSideKeyRef,
    resolvedSchemaTableNameCase,
    restoreAnalysisFromConfig,
    runAfterLoadRef,
    schemaAnalysisDiffs,
    schemaCaseSensitive,
    schemaCreateMissingTables,
    schemaFetchingRef,
    schemaTableSearch,
    schemaTargetStatusFilters,
    scrollSyncLockRef,
    setActiveTaskId,
    setAnalysisAnalyzedAt,
    setConflictDetailTable,
    setCountingTables,
    setIgnoredFields,
    setSchemaAnalysisDiffs,
    setSchemaAnalyzing,
    setSchemaCaseSensitive,
    setSchemaCreateMissingTables,
    setSchemaTableDiffs,
    setSchemaTableNameCase,
    setSchemaTableSearch,
    setSchemaTargetStatusFilters,
    setSourceConnId,
    setSourceDb,
    setSourceExpanded,
    setSourceSelected,
    setSubmitNotice,
    setTableAnalysis,
    setTableSyncModes,
    setTableTargetStatus,
    setTargetConnId,
    setTargetCountingTables,
    setTargetDb,
    setTargetRowCounts,
    setTaskName,
    sourceCatalogLoading,
    sourceConnId,
    sourceDb,
    sourceDbs,
    sourceDbsLoading,
    sourceExpanded,
    sourceListRef,
    sourceSelected,
    sourceSelectedTableNames,
    sourceSideBusy,
    sourceSnapshot,
    syncRunIdRef,
    syncTaskId,
    syncTasks,
    t,
    tab,
    tableAnalysis,
    tableSyncModes,
    targetConfigured,
    targetConnId,
    targetCountingRef,
    targetDb,
    targetDbs,
    targetDbsLoading,
    targetListRef,
    targetRowCounts,
    targetSnapshot,
    targetTablesLoading,
    taskInitializedRef,
    taskLoadAppliedRef,
    taskLoadRef,
    taskName,
    updateSyncTask,
    visibleSchemaAlignedTableNames,
  });
  const {
    canSaveTask,
    canPersistTask,
    resolveTaskName,
    persistTask,
    selectedTablesKey,
    expandedTablesKey,
    tableSyncModesKey,
    schemaAnalysisDiffsKey,
    tableAnalysisKey,
    targetRowCountsKey,
  } = lifeApi;

  const executeApi = useDatabaseToolboxExecute({
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
    tryUnlockSyncTables,
  });
  const {
    canSubmit,
    submitDisabledReason,
    dataSyncProgressLabel,
    conflictDetailIgnoredColumns,
    scriptPreviewInput,
    executeConfirmTitle,
    closeExecuteConfirmDialog,
    handleApplyTaskSettings,
    canSubmitTable,
    handleExecuteConfirm,
    handleSingleTableSubmit,
    handleSubmit,
    handleSourceConnectionChange,
    handleTargetConnectionChange,
  } = executeApi;

  return {
    t,
    loadTotal,
    loadCurrent,
    loadMessage,
    connections,
    tab,
    syncTaskId,
    sourceConnId,
    sourceDb,
    setSourceDb,
    targetConnId,
    targetDb,
    setTargetDb,
    sourceDbs,
    targetDbs,
    sourceDbsLoading,
    targetDbsLoading,
    sourceSnapshot,
    sourceCatalogNames,
    sourceCatalogLoading,
    sourceCatalogError,
    sourceAddingTables,
    targetSnapshot,
    targetTablesLoading,
    sourceExpanded,
    schemaCaseSensitive,
    schemaCreateMissingTables,
    schemaTargetStatusFilters,
    setSchemaTargetStatusFilters,
    schemaTableSearch,
    setSchemaTableSearch,
    ignoredFields,
    sourceListRef,
    targetListRef,
    sourceSelected,
    sourceListHighlight,
    setSourceListHighlight,
    tableTargetStatus,
    tableSyncModes,
    tableAnalysis,
    conflictDetailTable,
    setConflictDetailTable,
    submitting,
    syncLockedTables,
    submitNotice,
    taskSettingsOpen,
    setTaskSettingsOpen,
    taskHistoryOpen,
    setTaskHistoryOpen,
    taskScriptPreviewOpen,
    setTaskScriptPreviewOpen,
    executeConfirmSnapshot,
    taskName,
    targetConfigured,
    resolvedSchemaTableNameCase,
    countingTables,
    schemaDiffsForView,
    visibleSchemaAlignedTableNames,
    sourceSelectedTableNames,
    sourceTableColumns,
    sourceTableIndexes,
    sourceTableNameSet,
    toggleSourceTable,
    toggleSourceSelected,
    handleSourceSelectAll,
    syncSourceTableSelection,
    removeSourceTables,
    setTableSyncMode,
    canSubmitTable,
    handleSingleTableSubmit,
    handleViewConflictDetail,
    handleAnalyze,
    analyzeBusy,
    hasAnalysisResult,
    handleAnalyzeTable,
    dataSyncAnalyzingTables,
    scriptPreviewInput,
    executeConfirmTitle,
    closeExecuteConfirmDialog,
    handleExecuteConfirm,
    handleApplyTaskSettings,
    resolveTaskName,
    canSubmit,
    submitDisabledReason,
    canAnalyzeAll,
    analyzeAllDisabledReason,
    syncAnalysisBusy,
    hasDataAnalysisResult,
    handleDataAnalyze,
    handleSubmit,
    handleSourceConnectionChange,
    handleTargetConnectionChange,
    dataSyncProgressLabel,
    lastAnalysisTimeLabel,
    conflictDetailIgnoredColumns,
    EMPTY_SNAPSHOT,
  };
}
