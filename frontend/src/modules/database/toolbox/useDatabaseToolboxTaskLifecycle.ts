import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from "react";
import { useCallback, useEffect, useMemo } from "react";
import {
  parseIgnoredFieldsInput,
} from "./ignoredFields";
import {
  type DbConnectionConfig,
} from "../api";
import { useSchemaRowHeightSync, EMPTY_SCHEMA_SYNC_TABLE_NAMES } from "./useSchemaRowHeightSync";
import {
  resolveSchemaTableNameCase,
} from "./schemaSyncAlignedTables";
import {
  buildSyncAnalysisCache,
  buildSyncAnalysisConfigKey,
  pickAnalysisCacheForRestore,
  pickPersistableTableAnalysis,
} from "./syncTaskAnalysisCache";
import {
  type SchemaTableDiff,
} from "./schemaDiff";
import { useDbSyncTaskStore } from "../../../stores/dbSyncTaskStore";
import {
  normalizeTableSyncModes,
  resolveSchemaTargetStatusFiltersFromConfig,
  type DataAnalysisResult,
  type DataSyncModes,
  type SyncSideSnapshot,
  type SchemaTableNameCase,
  type SyncTaskConfig,
  type TableTargetStatus,
  type ToolboxTabId,
  type SchemaTargetRowStatus,
} from "./types";

export type UseDatabaseToolboxTaskLifecycleDeps = {
  active: boolean;
  analysisAnalyzedAt: number | null;
  analysisConfigKey: string;
  analyzingRef: MutableRefObject<any>;
  autoSavePausedRef: MutableRefObject<any>;
  cachedAnalysisLoadedKeyRef: MutableRefObject<any>;
  clearAnalysisState: () => void;
  clearPendingLoad: any;
  connections: DbConnectionConfig[];
  countingRef: MutableRefObject<any>;
  ignoredFields: string[];
  lastAnalysisConfigKeyRef: MutableRefObject<any>;
  lastAnalyzedSelectionRef: MutableRefObject<any>;
  lastPendingLoadNonceRef: MutableRefObject<any>;
  loadDataForCachedAnalysis: any;
  loadDatabases: any;
  loadedForSyncTaskRef: MutableRefObject<any>;
  pendingAddedTablesRef: MutableRefObject<any>;
  pendingLoad: any;
  prevAnalysisConfigKeyRef: MutableRefObject<any>;
  prevSourceConnIdRef: MutableRefObject<any>;
  prevSourceSideKeyRef: MutableRefObject<any>;
  prevSyncTaskIdForLoadRef: MutableRefObject<any>;
  prevTargetConnIdRef: MutableRefObject<any>;
  prevTargetSideKeyRef: MutableRefObject<any>;
  resolvedSchemaTableNameCase: SchemaTableNameCase;
  restoreAnalysisFromConfig: any;
  runAfterLoadRef: MutableRefObject<any>;
  schemaAnalysisDiffs: Record<string, SchemaTableDiff>;
  schemaCaseSensitive: boolean;
  schemaCreateMissingTables: boolean;
  schemaFetchingRef: MutableRefObject<any>;
  schemaTableSearch: string;
  schemaTargetStatusFilters: SchemaTargetRowStatus[];
  scrollSyncLockRef: MutableRefObject<any>;
  setActiveTaskId: Dispatch<SetStateAction<any>>;
  setAnalysisAnalyzedAt: Dispatch<SetStateAction<number | null>>;
  setConflictDetailTable: Dispatch<SetStateAction<string | null>>;
  setCountingTables: Dispatch<SetStateAction<Set<string>>>;
  setIgnoredFields: Dispatch<SetStateAction<string[]>>;
  setSchemaAnalysisDiffs: Dispatch<SetStateAction<Record<string, SchemaTableDiff>>>;
  setSchemaAnalyzing: Dispatch<SetStateAction<boolean>>;
  setSchemaCaseSensitive: Dispatch<SetStateAction<boolean>>;
  setSchemaCreateMissingTables: Dispatch<SetStateAction<boolean>>;
  setSchemaTableDiffs: Dispatch<SetStateAction<Record<string, SchemaTableDiff>>>;
  setSchemaTableNameCase: Dispatch<SetStateAction<SchemaTableNameCase>>;
  setSchemaTableSearch: Dispatch<SetStateAction<string>>;
  setSchemaTargetStatusFilters: Dispatch<SetStateAction<SchemaTargetRowStatus[]>>;
  setSourceConnId: Dispatch<SetStateAction<string>>;
  setSourceDb: Dispatch<SetStateAction<string>>;
  setSourceExpanded: Dispatch<SetStateAction<Set<string>>>;
  setSourceSelected: Dispatch<SetStateAction<Set<string>>>;
  setSubmitNotice: Dispatch<SetStateAction<string | null>>;
  setTableAnalysis: Dispatch<SetStateAction<Record<string, DataAnalysisResult>>>;
  setTableSyncModes: Dispatch<SetStateAction<Record<string, DataSyncModes>>>;
  setTableTargetStatus: Dispatch<SetStateAction<Record<string, TableTargetStatus>>>;
  setTargetConnId: Dispatch<SetStateAction<string>>;
  setTargetCountingTables: Dispatch<SetStateAction<Set<string>>>;
  setTargetDb: Dispatch<SetStateAction<string>>;
  setTargetRowCounts: Dispatch<SetStateAction<Record<string, number | null>>>;
  setTaskName: Dispatch<SetStateAction<string>>;
  sourceCatalogLoading: boolean;
  sourceConnId: string;
  sourceDb: string;
  sourceDbs: string[];
  sourceDbsLoading: boolean;
  sourceExpanded: Set<string>;
  sourceListRef: RefObject<HTMLDivElement | null>;
  sourceSelected: Set<string>;
  sourceSelectedTableNames: string[];
  sourceSideBusy: boolean;
  sourceSnapshot: SyncSideSnapshot;
  syncRunIdRef: MutableRefObject<any>;
  syncTaskId: string;
  syncTasks: Array<{ id: string; name: string }>;
  t: (key: string, params?: Record<string, string | number>) => string;
  tab: ToolboxTabId;
  tableAnalysis: Record<string, DataAnalysisResult>;
  tableSyncModes: Record<string, DataSyncModes>;
  targetConfigured: boolean;
  targetConnId: string;
  targetCountingRef: MutableRefObject<any>;
  targetDb: string;
  targetDbs: string[];
  targetDbsLoading: boolean;
  targetListRef: RefObject<HTMLDivElement | null>;
  targetRowCounts: Record<string, number | null>;
  targetSnapshot: SyncSideSnapshot;
  targetTablesLoading: boolean;
  taskInitializedRef: MutableRefObject<any>;
  taskLoadAppliedRef: MutableRefObject<any>;
  taskLoadRef: MutableRefObject<any>;
  taskName: string;
  updateSyncTask: any;
  visibleSchemaAlignedTableNames: string[] | undefined;
};

export function useDatabaseToolboxTaskLifecycle(deps: UseDatabaseToolboxTaskLifecycleDeps) {
  const {
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
    visibleSchemaAlignedTableNames
  } = deps;

const beginTaskLoad = useCallback((config: SyncTaskConfig, runAfterLoad: boolean) => {
  autoSavePausedRef.current = true;
  syncRunIdRef.current += 1;
  cachedAnalysisLoadedKeyRef.current = null;
  taskLoadAppliedRef.current = false;
  runAfterLoadRef.current = false;
  setSubmitNotice(null);
  setTableTargetStatus({});
  setTableAnalysis({});
  setSchemaTableDiffs({});
  setSchemaAnalysisDiffs({});
  setAnalysisAnalyzedAt(null);
  setSchemaAnalyzing(false);
  setConflictDetailTable(null);
  lastAnalyzedSelectionRef.current = new Set();
  analyzingRef.current.clear();
  countingRef.current.clear();
  targetCountingRef.current.clear();
  schemaFetchingRef.current.clear();
  lastAnalysisConfigKeyRef.current = "";
  prevAnalysisConfigKeyRef.current = null;
  setCountingTables(new Set());
  setTargetCountingTables(new Set());
  setTargetRowCounts({});
  setSourceSelected(new Set());
  setSourceExpanded(new Set());
  setTableSyncModes({});
  setSchemaCaseSensitive(config.schemaCaseSensitive ?? true);
  setSchemaTableNameCase(resolveSchemaTableNameCase(config.schemaTableNameCase));
  setSchemaCreateMissingTables(config.schemaCreateMissingTables !== false);
  setSchemaTargetStatusFilters(resolveSchemaTargetStatusFiltersFromConfig(config));
  setSchemaTableSearch(config.schemaTableSearch ?? "");
  setIgnoredFields(parseIgnoredFieldsInput(config.ignoredFields));
  const loadedAnalysisConfigKey = buildSyncAnalysisConfigKey({
    tab,
    sourceConnId: config.sourceConnId,
    sourceDb: config.sourceDb,
    targetConnId: config.targetConnId,
    targetDb: config.targetDb,
    schemaCaseSensitive: config.schemaCaseSensitive,
    schemaTableNameCase: resolveSchemaTableNameCase(config.schemaTableNameCase),
    schemaCreateMissingTables: config.schemaCreateMissingTables,
    ignoredFields: tab === "dataSync" ? config.ignoredFields : undefined,
  });
  if (!restoreAnalysisFromConfig(config, loadedAnalysisConfigKey)) {
    clearAnalysisState();
  }
  prevAnalysisConfigKeyRef.current = loadedAnalysisConfigKey;
  taskLoadRef.current = { config, runAfterLoad };
  prevSourceConnIdRef.current = config.sourceConnId;
  prevTargetConnIdRef.current = config.targetConnId;
  prevSourceSideKeyRef.current = `${tab}\0${config.sourceConnId}\0${(config.sourceDb ?? "").trim()}`;
  prevTargetSideKeyRef.current = `${config.targetConnId}\0${(config.targetDb ?? "").trim()}`;
  setSourceConnId(config.sourceConnId);
  setTargetConnId(config.targetConnId);
  setSourceDb(config.sourceDb ?? "");
  setTargetDb(config.targetDb ?? "");
  if (config.sourceConnId) {
    void loadDatabases(config.sourceConnId, "source");
  }
  if (config.targetConnId) {
    void loadDatabases(config.targetConnId, "target");
  }
}, [tab, restoreAnalysisFromConfig, clearAnalysisState, syncTaskId, loadDatabases]);

useEffect(() => {
  if (!active || !pendingLoad) {
    return;
  }
  if (pendingLoad.taskId !== syncTaskId) {
    return;
  }
  if (pendingLoad.nonce === lastPendingLoadNonceRef.current) {
    return;
  }
  const task = useDbSyncTaskStore.getState().tasks.find((item) => item.id === pendingLoad.taskId);
  if (!task || task.kind !== tab) {
    return;
  }
  lastPendingLoadNonceRef.current = pendingLoad.nonce;
  loadedForSyncTaskRef.current = null;
  clearPendingLoad();
  taskInitializedRef.current = true;
  setActiveTaskId(task.id);
  setTaskName(task.name);
  beginTaskLoad(task.config, pendingLoad.runAfterLoad);
}, [active, pendingLoad, tab, syncTaskId, clearPendingLoad, setActiveTaskId, beginTaskLoad]);

useEffect(() => {
  const prev = prevSyncTaskIdForLoadRef.current;
  if (prev !== undefined && prev !== syncTaskId) {
    taskInitializedRef.current = false;
    loadedForSyncTaskRef.current = null;
  }
  prevSyncTaskIdForLoadRef.current = syncTaskId;
}, [syncTaskId, tab]);

useEffect(() => {
  if (!active || pendingLoad || taskLoadRef.current || taskInitializedRef.current) {
    return;
  }
  if (loadedForSyncTaskRef.current === syncTaskId) {
    return;
  }
  const task = useDbSyncTaskStore.getState().tasks.find((item) => item.id === syncTaskId);
  if (!task || task.kind !== tab) {
    return;
  }
  taskInitializedRef.current = true;
  setActiveTaskId(syncTaskId);
  setTaskName(task.name);
  beginTaskLoad(task.config, false);
}, [active, pendingLoad, syncTaskId, tab, setActiveTaskId, beginTaskLoad]);

useEffect(() => {
  if (!syncTaskId) {
    return;
  }
  const task = syncTasks.find((item) => item.id === syncTaskId);
  if (task) {
    setTaskName((prev) => (prev === task.name ? prev : task.name));
  }
}, [syncTaskId, syncTasks]);

useEffect(() => {
  const load = taskLoadRef.current;
  if (!load || !active || taskLoadAppliedRef.current) {
    return;
  }
  const { config } = load;
  if (sourceConnId !== config.sourceConnId || targetConnId !== config.targetConnId) {
    return;
  }
  if (sourceDbsLoading || targetDbsLoading) {
    return;
  }
  if (!sourceDb && config.sourceDb && sourceDbs.includes(config.sourceDb)) {
    setSourceDb(config.sourceDb);
    return;
  }
  if (!targetDb && config.targetDb && targetDbs.includes(config.targetDb)) {
    setTargetDb(config.targetDb);
    return;
  }
  if (sourceDb !== config.sourceDb || targetDb !== config.targetDb) {
    if (
      !sourceDbsLoading &&
      !targetDbsLoading &&
      sourceConnId === config.sourceConnId &&
      targetConnId === config.targetConnId &&
      (!config.sourceDb || !sourceDbs.includes(config.sourceDb) || !config.targetDb || !targetDbs.includes(config.targetDb))
    ) {
      taskLoadRef.current = null;
      autoSavePausedRef.current = false;
    }
    return;
  }

  taskLoadAppliedRef.current = true;
  const addedNames =
    config.addedTables && config.addedTables.length > 0
      ? config.addedTables
      : config.selectedTables;
  // 数据同步：按已保存表名逐个加载结构；结构同步源侧直接全库加载，仅恢复勾选
  pendingAddedTablesRef.current =
    tab === "dataSync" && addedNames.length > 0 ? addedNames : null;
  // 数据同步：列表中的表即参与同步/分析（不再用独立勾选）
  setSourceSelected(new Set(tab === "dataSync" ? addedNames : config.selectedTables));
  setSourceExpanded(new Set(config.expandedTables ?? []));
  setTableSyncModes(
    normalizeTableSyncModes(config.tableSyncModes, config.tableSyncStrategies),
  );
  if (tab === "dataSync") {
    const cacheKey = buildSyncAnalysisConfigKey({
      tab,
      sourceConnId: config.sourceConnId,
      sourceDb: config.sourceDb,
      targetConnId: config.targetConnId,
      targetDb: config.targetDb,
      schemaCaseSensitive: config.schemaCaseSensitive,
      ignoredFields: tab === "dataSync" ? config.ignoredFields : undefined,
    });
    const cached = pickAnalysisCacheForRestore(config.analysisCache, cacheKey);
    if (cached?.tableAnalysis) {
      const selectedSet = new Set(config.selectedTables);
      lastAnalyzedSelectionRef.current = new Set(
        Object.keys(cached.tableAnalysis).filter((name) => selectedSet.has(name)),
      );
    }
  }
  loadDataForCachedAnalysis(config);
  const runAfter = load.runAfterLoad;
  taskLoadRef.current = null;
  autoSavePausedRef.current = false;
  loadedForSyncTaskRef.current = syncTaskId;
  if (runAfter) {
    runAfterLoadRef.current = true;
  }
}, [
  active,
  sourceConnId,
  targetConnId,
  sourceDb,
  targetDb,
  sourceDbs,
  targetDbs,
  sourceDbsLoading,
  targetDbsLoading,
  tab,
  sourceSnapshot.tables,
  syncTaskId,
  loadDataForCachedAnalysis,
]);

const buildTaskConfig = useCallback((): SyncTaskConfig => {
  const persistableTableAnalysis =
    tab === "dataSync" ? pickPersistableTableAnalysis(tableAnalysis) : {};
  const hasPersistableAnalysis =
    tab === "schemaSync"
      ? Object.keys(schemaAnalysisDiffs).length > 0
      : Object.values(persistableTableAnalysis).some(
          (result) =>
            result.status === "match" || result.status === "diff" || result.status === "error",
        );
  const analysisCache =
    analysisAnalyzedAt !== null && hasPersistableAnalysis
      ? buildSyncAnalysisCache({
          configKey: analysisConfigKey,
          analyzedAt: analysisAnalyzedAt,
          tab,
          schemaDiffs: tab === "schemaSync" ? schemaAnalysisDiffs : undefined,
          tableAnalysis: tab === "dataSync" ? persistableTableAnalysis : undefined,
          targetRowCounts: tab === "dataSync" ? targetRowCounts : undefined,
        })
      : undefined;

  return {
    sourceConnId,
    sourceDb,
    targetConnId,
    targetDb,
    selectedTables:
      tab === "dataSync"
        ? sourceSnapshot.tables.map((table) => table.name)
        : Array.from(sourceSelected),
    addedTables:
      tab === "dataSync" ? sourceSnapshot.tables.map((table) => table.name) : undefined,
    expandedTables: Array.from(sourceExpanded),
    tableSyncModes: { ...tableSyncModes },
    ...(tab === "dataSync" ? { ignoredFields: parseIgnoredFieldsInput(ignoredFields) } : {}),
    ...(tab === "schemaSync"
      ? {
          schemaCaseSensitive,
          schemaTableNameCase: resolvedSchemaTableNameCase,
          schemaCreateMissingTables,
          schemaTargetStatusFilter: schemaTargetStatusFilters,
          schemaTableSearch,
        }
      : {}),
    ...(analysisCache ? { analysisCache } : {}),
  };
}, [
  sourceConnId,
  sourceDb,
  targetConnId,
  targetDb,
  sourceSelected,
  sourceSnapshot.tables,
  sourceExpanded,
  tableSyncModes,
  ignoredFields,
  tab,
  schemaCaseSensitive,
  resolvedSchemaTableNameCase,
  schemaCreateMissingTables,
  schemaTargetStatusFilters,
  schemaTableSearch,
  analysisAnalyzedAt,
  analysisConfigKey,
  schemaAnalysisDiffs,
  tableAnalysis,
  targetRowCounts,
]);

const canSaveTask = useMemo(() => {
  return Boolean(sourceConnId && sourceDb.trim() && targetConnId && targetDb.trim());
}, [sourceConnId, sourceDb, targetConnId, targetDb]);

const canPersistTask = Boolean(syncTaskId);

const resolveTaskName = useCallback(() => {
  const trimmed = taskName.trim();
  if (trimmed) {
    return trimmed;
  }
  const sourceConn = connections.find((c) => c.id === sourceConnId);
  const targetConn = connections.find((c) => c.id === targetConnId);
  if (sourceConn && targetConn) {
    return `${sourceConn.name}/${sourceDb} → ${targetConn.name}/${targetDb}`;
  }
  return t("database.syncTasks.defaultName");
}, [taskName, connections, sourceConnId, sourceDb, targetConnId, targetDb, t]);

const persistTask = useCallback(() => {
  const name = resolveTaskName();
  const config = buildTaskConfig();
  const saved = useDbSyncTaskStore.getState().tasks.find((item) => item.id === syncTaskId);
  if (saved) {
    if (!config.sourceDb.trim() && saved.config.sourceDb.trim()) {
      config.sourceDb = saved.config.sourceDb;
    }
    if (!config.targetDb.trim() && saved.config.targetDb.trim()) {
      config.targetDb = saved.config.targetDb;
    }
  }
  updateSyncTask(syncTaskId, { name, kind: tab, config });
}, [resolveTaskName, buildTaskConfig, updateSyncTask, syncTaskId, tab]);

const selectedTablesKey = useMemo(
  () => Array.from(sourceSelected).sort((a, b) => a.localeCompare(b)).join("\0"),
  [sourceSelected],
);

const expandedTablesKey = useMemo(
  () => Array.from(sourceExpanded).sort((a, b) => a.localeCompare(b)).join("\0"),
  [sourceExpanded],
);

const tableSyncModesKey = useMemo(
  () => JSON.stringify(tableSyncModes),
  [tableSyncModes],
);

const schemaAnalysisDiffsKey = useMemo(
  () => JSON.stringify(schemaAnalysisDiffs),
  [schemaAnalysisDiffs],
);

const schemaRowHeightSyncKey = useMemo(() => {
  const names = visibleSchemaAlignedTableNames?.join("\0") ?? "";
  return `${expandedTablesKey}\0${names}\0${schemaAnalysisDiffsKey}`;
}, [expandedTablesKey, visibleSchemaAlignedTableNames, schemaAnalysisDiffsKey]);

const schemaExpandedTableNames = useMemo(() => {
  if (!visibleSchemaAlignedTableNames || sourceExpanded.size === 0) {
    return EMPTY_SCHEMA_SYNC_TABLE_NAMES;
  }
  return visibleSchemaAlignedTableNames.filter((name) => sourceExpanded.has(name));
}, [visibleSchemaAlignedTableNames, expandedTablesKey]);

const schemaRowHeightSyncEnabled =
  tab === "schemaSync" &&
  targetConfigured &&
  !sourceSideBusy &&
  !targetSnapshot.loading &&
  schemaExpandedTableNames.length > 0;

useSchemaRowHeightSync(
  sourceListRef,
  targetListRef,
  schemaExpandedTableNames,
  schemaRowHeightSyncEnabled,
  schemaRowHeightSyncKey,
);

const tableAnalysisKey = useMemo(
  () => JSON.stringify(tableAnalysis),
  [tableAnalysis],
);

const dataSyncAlignedTableNames = useMemo(() => {
  if (tab !== "dataSync") {
    return EMPTY_SCHEMA_SYNC_TABLE_NAMES;
  }
  return [...sourceSelectedTableNames].sort((a, b) => a.localeCompare(b));
}, [tab, sourceSelectedTableNames]);

const dataSyncRowHeightSyncKey = useMemo(() => {
  return `${dataSyncAlignedTableNames.join("\0")}\0${tableAnalysisKey}\0${tableSyncModesKey}`;
}, [dataSyncAlignedTableNames, tableAnalysisKey, tableSyncModesKey]);

const dataSyncRowHeightSyncEnabled =
  tab === "dataSync" &&
  targetConfigured &&
  !sourceSideBusy &&
  !targetTablesLoading &&
  !sourceCatalogLoading &&
  dataSyncAlignedTableNames.length > 0;

useSchemaRowHeightSync(
  sourceListRef,
  targetListRef,
  dataSyncAlignedTableNames,
  dataSyncRowHeightSyncEnabled,
  dataSyncRowHeightSyncKey,
);

useEffect(() => {
  if (tab !== "schemaSync" && tab !== "dataSync") {
    return;
  }
  if (tab === "schemaSync" && sourceExpanded.size === 0) {
    return;
  }
  if (tab === "dataSync" && dataSyncAlignedTableNames.length === 0) {
    return;
  }
  const sourceEl = sourceListRef.current;
  const targetEl = targetListRef.current;
  if (!sourceEl || !targetEl) {
    return;
  }
  const frame = requestAnimationFrame(() => {
    scrollSyncLockRef.current = true;
    targetEl.scrollTop = sourceEl.scrollTop;
    requestAnimationFrame(() => {
      scrollSyncLockRef.current = false;
    });
  });
  return () => cancelAnimationFrame(frame);
}, [tab, expandedTablesKey, visibleSchemaAlignedTableNames, dataSyncAlignedTableNames, tableAnalysisKey, tableSyncModesKey]);

const targetRowCountsKey = useMemo(
  () => JSON.stringify(targetRowCounts),
  [targetRowCounts],
);

  return {
    beginTaskLoad,
    buildTaskConfig,
    canSaveTask,
    canPersistTask,
    resolveTaskName,
    persistTask,
    selectedTablesKey,
    expandedTablesKey,
    tableSyncModesKey,
    schemaAnalysisDiffsKey,
    schemaRowHeightSyncKey,
    schemaExpandedTableNames,
    schemaRowHeightSyncEnabled,
    tableAnalysisKey,
    dataSyncAlignedTableNames,
    dataSyncRowHeightSyncKey,
    dataSyncRowHeightSyncEnabled,
    targetRowCountsKey
  };
}
