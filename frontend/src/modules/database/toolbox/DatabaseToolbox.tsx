import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useI18n } from "../../../i18n";
import { Button } from "../../../components/ui/Button";
import { IconSettings, IconClock, IconFile } from "../../../components/ui/Icons";
import { useDataLoading } from "../../../components/ui/DataLoading";
import { SubWindow } from "../../../components/ui/SubWindow";
import { appConfirm } from "../../../lib/appConfirm";
import {
  cancelDbBackgroundTask,
  startDbDataSyncBackgroundTask,
  startDbSchemaSyncBackgroundTask,
  startDbDataSyncSqlExecute,
  startDbSchemaSyncExecute,
  useDbSyncBackgroundTaskEvents,
} from "./useDbSyncBackgroundTasks";
import type { BackgroundTaskInfo } from "../../../stores/backgroundTaskStore";
import {
  formatBackgroundTaskStatusMessage,
  useBackgroundTaskStore,
} from "../../../stores/backgroundTaskStore";
import {
  applyIgnoredFieldsToAnalysisResult,
  ignoredColumnsForTable,
  parseIgnoredFieldsInput,
} from "./ignoredFields";
import {
  countTable,
  introspectSchema,
  introspectTable,
  listDatabases,
  listTables,
  type DbConnectionConfig,
  type DbColumnMeta,
  type DbIndexMeta,
} from "../api";
import { SyncSidePanel } from "./SyncSidePanel";
import { useSchemaRowHeightSync, EMPTY_SCHEMA_SYNC_TABLE_NAMES } from "./useSchemaRowHeightSync";
import { SyncTaskSettingsDialog, type SyncTaskSettings } from "./SyncTaskSettingsDialog";
import { SyncTaskHistoryPanel } from "./SyncTaskHistoryPanel";
import { SyncTaskScriptPreviewPanel } from "./SyncTaskScriptPreviewPanel";
import { SyncTaskExecuteConfirmDialog } from "./SyncTaskExecuteConfirmDialog";
import type { SyncTaskSqlPreviewInput } from "./syncTaskSqlPreview";
import {
  summarizeSqlPreviewInput,
  syncExecuteConfirmLog,
  syncExecuteConfirmWarn,
} from "./syncExecuteConfirmDebug";
import {
  buildSchemaAlignedTableNames,
  filterAlignedTableNames,
  filterAlignedTableNamesByStatus,
  findTableByName,
  isSchemaCaseSensitive,
  tableNameExistsInSet,
  isSchemaSyncSourceTableMissingInTarget,
  filterSchemaSyncExecutableTableNames,
  isSchemaSyncTableExecutable,
  resolveSchemaTableNameCase,
} from "./schemaSyncAlignedTables";
import {
  buildSyncAnalysisCache,
  buildSyncAnalysisConfigKey,
  pickAnalysisCacheForRestore,
  pickPersistableTableAnalysis,
} from "./syncTaskAnalysisCache";
import { DbToolboxSplitLayout } from "./DbToolboxSplitLayout";
import { ModuleEmptyState } from "../../../components/ui/ModuleEmptyState";
import {
  buildNewTableDiff,
  buildSchemaTableDiffFromSnapshots,
  sourceTableSchemaSignature,
  type SchemaTableDiff,
} from "./schemaDiff";
import { TableRowDiffPanel } from "./TableRowDiffPanel";
import { useDbSyncTaskStore } from "../../../stores/dbSyncTaskStore";
import {
  connectionWithDatabase,
  resolveTableTargetStatusWithAnalysis,
  DEFAULT_DATA_SYNC_MODES,
  normalizeDataSyncModes,
  normalizeTableSyncModes,
  type DataAnalysisResult,
  type DataSyncModes,
  type SyncSideSnapshot,
  type SyncTableInfo,
  type SyncTaskAnalysisStatus,
  type SchemaTableNameCase,
  type SyncTaskConfig,
  type TableTargetStatus,
  type ToolboxTabId,
  type SchemaTargetRowStatus,
  resolveSchemaTargetStatusFiltersFromConfig,
  isSchemaTargetStatusFilterShowAll,
} from "./types";

const EMPTY_SNAPSHOT: SyncSideSnapshot = { tables: [], loading: false, error: null };

/** 逐条比对的行数门槛 */
const LARGE_TABLE_ROW_THRESHOLD = 10_000;

/** 稳定空对象，避免 schemaDiffsForView 每次返回新 `{}` 触发对齐列表重算 */
const EMPTY_SCHEMA_TABLE_DIFFS: Record<string, SchemaTableDiff> = {};

const EXECUTE_TASK_KINDS = new Set(["dbDataSyncExecute", "dbSchemaSyncExecute"]);
const TERMINAL_EXECUTE_STATUSES = new Set(["completed", "failed"]);

/** 跨组件实例去重：避免 Strict Mode / 重复订阅导致同步完成回调触发两次分析 */
const globalProcessedExecuteTaskIds = new Set<string>();

function claimExecuteTaskCompletion(taskId: string): boolean {
  if (globalProcessedExecuteTaskIds.has(taskId)) {
    return false;
  }
  globalProcessedExecuteTaskIds.add(taskId);
  return true;
}

interface DatabaseToolboxProps {
  connections: DbConnectionConfig[];
  /** 数据同步 / 结构同步（由 Dock Tab 绑定任务类型决定） */
  tab: ToolboxTabId;
  /** 绑定的同步任务；每个 Dock Panel 对应一个任务 */
  syncTaskId: string;
  /** 打开工具箱时默认源库连接 */
  initialSourceConnectionId?: string | null;
  initialSourceDatabase?: string;
  /** 为 false 时不发起任何库连接请求（分段 Tab 未激活时由父级传入） */
  active?: boolean;
}

export function DatabaseToolbox({
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

  const restoreAnalysisFromConfig = useCallback(
    (config: SyncTaskConfig, configKeyOverride?: string): boolean => {
      const key =
        configKeyOverride ??
        buildSyncAnalysisConfigKey({
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
      const cached = pickAnalysisCacheForRestore(config.analysisCache, key);
      if (!cached) {
        return false;
      }
      if (
        lastAnalysisConfigKeyRef.current === key &&
        analysisAnalyzedAtRef.current === cached.analyzedAt
      ) {
        return true;
      }
      if (cached.schemaDiffs && tab === "schemaSync") {
        setSchemaAnalysisDiffs((prev) => {
          if (JSON.stringify(prev) === JSON.stringify(cached.schemaDiffs)) {
            return prev;
          }
          return cached.schemaDiffs!;
        });
      } else {
        setSchemaAnalysisDiffs((prev) => (Object.keys(prev).length === 0 ? prev : {}));
      }
      if (cached.tableAnalysis && tab === "dataSync") {
        const ignored = parseIgnoredFieldsInput(
          tab === "dataSync" ? ignoredFields : config.ignoredFields,
        );
        const sanitized: Record<string, DataAnalysisResult> = {};
        for (const [name, result] of Object.entries(cached.tableAnalysis)) {
          if (result.status !== "analyzing") {
            sanitized[name] = applyIgnoredFieldsToAnalysisResult(name, result, ignored);
          }
        }
        const sanitizedKey = JSON.stringify(sanitized);
        setTableAnalysis((prev) => (JSON.stringify(prev) === sanitizedKey ? prev : sanitized));
        lastAnalyzedSelectionRef.current = new Set(Object.keys(sanitized));
      } else if (tab === "dataSync") {
        setTableAnalysis((prev) => (Object.keys(prev).length === 0 ? prev : {}));
        lastAnalyzedSelectionRef.current = new Set();
      }
      if (cached.targetRowCounts && tab === "dataSync") {
        setTargetRowCounts((prev) => {
          if (JSON.stringify(prev) === JSON.stringify(cached.targetRowCounts)) {
            return prev;
          }
          return cached.targetRowCounts!;
        });
      } else if (tab === "dataSync") {
        setTargetRowCounts((prev) => (Object.keys(prev).length === 0 ? prev : {}));
      }
      setAnalysisAnalyzedAt((prev) =>
        prev === cached.analyzedAt ? prev : cached.analyzedAt,
      );
      lastAnalysisConfigKeyRef.current = key;
      return true;
    },
    [tab, ignoredFields],
  );

  const clearAnalysisState = useCallback(() => {
    setSchemaAnalysisDiffs({});
    setAnalysisAnalyzedAt(null);
    setTableAnalysis({});
    setTargetRowCounts({});
    lastAnalyzedSelectionRef.current = new Set();
    lastAnalysisConfigKeyRef.current = "";
  }, []);

  const pickDefaultConnId = useCallback(
    (preferred?: string | null) => {
      if (preferred && connections.some((c) => c.id === preferred)) {
        return preferred;
      }
      return connections[0]?.id ?? "";
    },
    [connections],
  );

  useEffect(() => {
    if (!active || taskLoadRef.current) {
      return;
    }
    const defaultConn = pickDefaultConnId(initialSourceConnectionId);
    setSourceConnId((prev) => {
      if (prev && connections.some((c) => c.id === prev)) {
        return prev;
      }
      return prev === defaultConn ? prev : defaultConn;
    });
    setTargetConnId((prev) => {
      if (prev && connections.some((c) => c.id === prev)) {
        return prev;
      }
      return prev === defaultConn ? prev : defaultConn;
    });
  }, [active, initialSourceConnectionId, pickDefaultConnId, connections]);

  useEffect(() => {
    if (!active || taskLoadRef.current) {
      return;
    }
    const db = initialSourceDatabase.trim();
    if (!db || sourceDbs.length === 0) {
      return;
    }
    if (sourceDbs.includes(db)) {
      setSourceDb(db);
    }
  }, [active, initialSourceDatabase, sourceDbs]);

  useEffect(() => {
    if (!active || taskLoadRef.current) {
      return;
    }
    const db = initialSourceDatabase.trim();
    if (!db || targetDbs.length === 0) {
      return;
    }
    if (targetDbs.includes(db)) {
      setTargetDb(db);
    }
  }, [active, initialSourceDatabase, targetDbs]);

  const loadDatabases = useCallback(
    async (connId: string, side: "source" | "target") => {
      const conn = connections.find((c) => c.id === connId);
      const setDbs = side === "source" ? setSourceDbs : setTargetDbs;
      const setDb = side === "source" ? setSourceDb : setTargetDb;
      const setLoading = side === "source" ? setSourceDbsLoading : setTargetDbsLoading;

      if (!conn) {
        setDbs([]);
        return;
      }
      setLoading(true);
      try {
        const names = await listDatabases(conn);
        setDbs(names);
        setDb((current) => (current && names.includes(current) ? current : ""));
      } catch (e) {
        setDbs([]);
        setDb("");
        console.error("[DatabaseToolbox] listDatabases failed:", e);
      } finally {
        setLoading(false);
      }
    },
    [connections],
  );

  useEffect(() => {
    if (!active) {
      prevSourceConnIdRef.current = null;
      return;
    }
    if (taskLoadRef.current) {
      return;
    }
    if (!sourceConnId) {
      if (prevSourceConnIdRef.current !== null) {
        setSourceDbs([]);
        setSourceDb("");
        prevSourceConnIdRef.current = null;
      }
      return;
    }
    if (prevSourceConnIdRef.current === sourceConnId) {
      return;
    }
    prevSourceConnIdRef.current = sourceConnId;
    setSourceDbs([]);
    setSourceDb("");
    void loadDatabases(sourceConnId, "source");
  }, [active, sourceConnId, loadDatabases]);

  useEffect(() => {
    if (!active) {
      prevTargetConnIdRef.current = null;
      return;
    }
    if (taskLoadRef.current) {
      return;
    }
    if (!targetConnId) {
      if (prevTargetConnIdRef.current !== null) {
        setTargetDbs([]);
        setTargetDb("");
        prevTargetConnIdRef.current = null;
      }
      return;
    }
    if (prevTargetConnIdRef.current === targetConnId) {
      return;
    }
    prevTargetConnIdRef.current = targetConnId;
    setTargetDbs([]);
    setTargetDb("");
    void loadDatabases(targetConnId, "target");
  }, [active, targetConnId, loadDatabases]);

  const loadTargetTableNames = useCallback(async () => {
    const conn = connections.find((c) => c.id === targetConnId);
    const db = targetDb.trim();
    if (!conn || !db || !targetDbs.includes(db)) {
      setTargetTableNames(new Set());
      return;
    }
    setTargetTablesLoading(true);
    try {
      const scoped = connectionWithDatabase(conn, db);
      const names = await listTables(scoped, db);
      setTargetTableNames(new Set(names));
    } catch (e) {
      setTargetTableNames(new Set());
      console.error("[DatabaseToolbox] listTables (target) failed:", e);
    } finally {
      setTargetTablesLoading(false);
    }
  }, [connections, targetConnId, targetDb, targetDbs]);

  const loadTargetSnapshot = useCallback(async () => {
    if (tab !== "schemaSync") {
      setTargetSnapshot(EMPTY_SNAPSHOT);
      return;
    }
    const conn = connections.find((c) => c.id === targetConnId);
    const db = targetDb.trim();
    if (!conn || !db || !targetDbs.includes(db)) {
      setTargetSnapshot(EMPTY_SNAPSHOT);
      return;
    }
    setTargetSnapshot({ tables: [], loading: true, error: null });
    try {
      const scoped = connectionWithDatabase(conn, db);
      const result = await introspectSchema(scoped, db);
      const tables: SyncTableInfo[] = result.tables.map((tbl) => ({
        name: tbl.name,
        columns: tbl.columns,
        indexes: tbl.indexes ?? [],
        rowCount: 0,
      }));
      tables.sort((a, b) => a.name.localeCompare(b.name));
      setTargetSnapshot({ tables, loading: false, error: null });
      setTargetTableNames(new Set(tables.map((table) => table.name)));
    } catch (e) {
      setTargetSnapshot({
        tables: [],
        loading: false,
        error: typeof e === "string" ? e : String(e),
      });
      setTargetTableNames(new Set());
      console.error("[DatabaseToolbox] introspectSchema (target) failed:", e);
    }
  }, [connections, tab, targetConnId, targetDb, targetDbs]);

  useEffect(() => {
    if (!active) {
      return;
    }
    if (tab === "schemaSync") {
      void loadTargetSnapshot();
      return;
    }
    setTargetSnapshot(EMPTY_SNAPSHOT);
  }, [active, tab, loadTargetSnapshot]);

  useEffect(() => {
    if (tab !== "schemaSync") {
      setSchemaTableSearch("");
    }
  }, [tab, sourceConnId, sourceDb, targetConnId, targetDb]);

  useEffect(() => {
    if (tab !== "schemaSync" && tab !== "dataSync") {
      return;
    }
    if (!targetConfigured) {
      return;
    }
    if (tab === "schemaSync" && (sourceSideBusy || targetSnapshot.loading)) {
      return;
    }
    if (tab === "dataSync" && (sourceSideBusy || targetTablesLoading || sourceCatalogLoading)) {
      return;
    }
    const sourceEl = sourceListRef.current;
    const targetEl = targetListRef.current;
    if (!sourceEl || !targetEl) {
      return;
    }

    const syncFrom = (from: HTMLDivElement, to: HTMLDivElement) => {
      if (scrollSyncLockRef.current) {
        return;
      }
      scrollSyncLockRef.current = true;
      to.scrollTop = from.scrollTop;
      requestAnimationFrame(() => {
        scrollSyncLockRef.current = false;
      });
    };

    const onSourceScroll = () => syncFrom(sourceEl, targetEl);
    const onTargetScroll = () => syncFrom(targetEl, sourceEl);
    sourceEl.addEventListener("scroll", onSourceScroll, { passive: true });
    targetEl.addEventListener("scroll", onTargetScroll, { passive: true });
    return () => {
      sourceEl.removeEventListener("scroll", onSourceScroll);
      targetEl.removeEventListener("scroll", onTargetScroll);
    };
  }, [
    tab,
    targetConfigured,
    sourceSideBusy,
    targetSnapshot.loading,
    targetTablesLoading,
    sourceCatalogLoading,
  ]);

  useEffect(() => {
    if (!active) {
      return;
    }
    if (tab === "schemaSync") {
      return;
    }
    void loadTargetTableNames();
  }, [active, tab, loadTargetTableNames]);

  useEffect(() => {
    const targetKey = `${targetConnId}\0${targetDb.trim()}`;
    if (prevTargetSideKeyRef.current === targetKey) {
      return;
    }
    prevTargetSideKeyRef.current = targetKey;
    // 任务加载期间会恢复 analysisCache 中的 targetRowCounts，此处跳过清空避免目标侧一直「检测中」
    if (taskLoadRef.current) {
      return;
    }
    syncRunIdRef.current += 1;
    targetCountingRef.current.clear();
    setTargetCountingTables(new Set());
    setTargetRowCounts({});
  }, [targetConnId, targetDb]);

  const loadSourceCatalog = useCallback(
    async (connId: string, database: string) => {
      const conn = connections.find((c) => c.id === connId);
      if (!conn || !database.trim()) {
        setSourceCatalogNames([]);
        setSourceCatalogLoading(false);
        setSourceCatalogError(null);
        setSourceSnapshot(EMPTY_SNAPSHOT);
        return;
      }

      resetLoadProgress(1, t("database.toolbox.loading.tableList"));
      setSourceCatalogLoading(true);
      setSourceCatalogError(null);
      try {
        const scoped = connectionWithDatabase(conn, database);
        const names = await listTables(scoped, database);
        names.sort((a, b) => a.localeCompare(b));
        setSourceCatalogNames(names);
        advanceLoadProgress(1, t("database.toolbox.loading.tableListDone", { count: names.length }));
      } catch (e) {
        setSourceCatalogNames([]);
        setSourceCatalogError(typeof e === "string" ? e : String(e));
      } finally {
        setSourceCatalogLoading(false);
      }
    },
    [connections, resetLoadProgress, advanceLoadProgress, t],
  );

  /** 结构同步：源侧加载库内全部表结构（与目标侧 introspectSchema 对称） */
  const loadSourceSnapshot = useCallback(async () => {
    if (tab !== "schemaSync") {
      return;
    }
    const conn = connections.find((c) => c.id === sourceConnId);
    const db = sourceDb.trim();
    if (!conn || !db) {
      setSourceSnapshot(EMPTY_SNAPSHOT);
      setSourceCatalogNames([]);
      setSourceCatalogError(null);
      return;
    }
    resetLoadProgress(1, t("database.toolbox.loading.schema"));
    setSourceCatalogError(null);
    setSourceSnapshot({ tables: [], loading: true, error: null });
    try {
      const scoped = connectionWithDatabase(conn, db);
      const result = await introspectSchema(scoped, db);
      const tables: SyncTableInfo[] = result.tables.map((tbl) => ({
        name: tbl.name,
        columns: tbl.columns,
        indexes: tbl.indexes ?? [],
        rowCount: 0,
      }));
      tables.sort((a, b) => a.name.localeCompare(b.name));
      setSourceSnapshot({ tables, loading: false, error: null });
      setSourceCatalogNames(tables.map((table) => table.name));
      advanceLoadProgress(1, t("database.toolbox.loading.schemaDone", { count: tables.length }));
    } catch (e) {
      const message = typeof e === "string" ? e : String(e);
      setSourceSnapshot({
        tables: [],
        loading: false,
        error: message,
      });
      setSourceCatalogNames([]);
      setSourceCatalogError(message);
    }
  }, [
    connections,
    tab,
    sourceConnId,
    sourceDb,
    resetLoadProgress,
    advanceLoadProgress,
    t,
  ]);

  const addSourceTables = useCallback(
    async (tableNames: string[]) => {
      const conn = connections.find((c) => c.id === sourceConnId);
      if (!conn || !sourceDb.trim() || tableNames.length === 0) {
        return;
      }

      const catalogSet = new Set(sourceCatalogNamesRef.current);
      const addedSet = new Set(sourceSnapshotTablesRef.current.map((table) => table.name));
      const unique = tableNames.filter(
        (name, index, arr) =>
          arr.indexOf(name) === index && catalogSet.has(name) && !addedSet.has(name),
      );
      if (unique.length === 0) {
        return;
      }

      const runId = ++addSourceTablesRunRef.current;
      setSourceAddingTables(true);
      setSourceSnapshot((prev) => ({ ...prev, error: null }));

      const scoped = connectionWithDatabase(conn, sourceDb);
      const newTables: SyncTableInfo[] = [];
      try {
        for (const name of unique) {
          if (addSourceTablesRunRef.current !== runId) {
            return;
          }
          const schema = await introspectTable(scoped, sourceDb, name);
          newTables.push({
            name: schema.name,
            columns: schema.columns,
            indexes: schema.indexes ?? [],
            rowCount: tab === "dataSync" ? null : 0,
          });
        }
        if (addSourceTablesRunRef.current !== runId) {
          return;
        }
        setSourceSnapshot((prev) => ({
          ...prev,
          tables: [...prev.tables, ...newTables].sort((a, b) => a.name.localeCompare(b.name)),
          loading: false,
          error: null,
        }));
        setSourceSelected((prev) => {
          const next = new Set(prev);
          for (const table of newTables) {
            next.add(table.name);
          }
          return next;
        });
      } catch (e) {
        if (addSourceTablesRunRef.current !== runId) {
          return;
        }
        setSourceSnapshot((prev) => ({
          ...prev,
          error: typeof e === "string" ? e : String(e),
        }));
      } finally {
        if (addSourceTablesRunRef.current === runId) {
          setSourceAddingTables(false);
        }
      }
    },
    [connections, sourceConnId, sourceDb, tab],
  );

  const loadDataForCachedAnalysis = useCallback(
    (config: SyncTaskConfig) => {
      const key = buildSyncAnalysisConfigKey({
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
      if (!pickAnalysisCacheForRestore(config.analysisCache, key)) {
        return;
      }
      const loadKey = `${syncTaskId ?? ""}\0${key}`;
      if (cachedAnalysisLoadedKeyRef.current === loadKey) {
        return;
      }
      cachedAnalysisLoadedKeyRef.current = loadKey;
      if (config.sourceConnId && config.sourceDb.trim()) {
        if (tab === "schemaSync") {
          void loadSourceSnapshot();
        } else {
          void loadSourceCatalog(config.sourceConnId, config.sourceDb);
        }
      }
      if (tab === "schemaSync") {
        void loadTargetSnapshot();
      } else {
        void loadTargetTableNames();
      }
    },
    [tab, syncTaskId, loadSourceCatalog, loadSourceSnapshot, loadTargetSnapshot, loadTargetTableNames],
  );

  useEffect(() => {
    if (!active) {
      return;
    }
    const sideKey = `${tab}\0${sourceConnId}\0${sourceDb.trim()}`;
    if (prevSourceSideKeyRef.current === sideKey) {
      return;
    }
    prevSourceSideKeyRef.current = sideKey;

    syncRunIdRef.current += 1;
    countingRef.current.clear();
    setCountingTables(new Set());
    targetCountingRef.current.clear();
    setTargetCountingTables(new Set());
    schemaFetchingRef.current.clear();
    setSchemaTableDiffs({});
    if (!taskLoadRef.current) {
      setSourceSelected(new Set());
      setSourceSnapshot(EMPTY_SNAPSHOT);
      setTableTargetStatus({});
      setTableSyncModes({});
      setConflictDetailTable(null);
      setSubmitNotice(null);
      analyzingRef.current.clear();
      lastAnalyzedSelectionRef.current = new Set();
      pendingAddedTablesRef.current = null;
    }
    // 数据同步：只拉表名目录，由表头下拉按需添加
    if (tab === "dataSync") {
      void loadSourceCatalog(sourceConnId, sourceDb);
    }
  }, [active, sourceConnId, sourceDb, tab, loadSourceCatalog]);

  // 结构同步：选完库后直接加载并展示源库全部表（不走「添加」）
  useEffect(() => {
    if (!active || tab !== "schemaSync") {
      return;
    }
    void loadSourceSnapshot();
  }, [active, tab, loadSourceSnapshot]);

  useEffect(() => {
    if (tab !== "dataSync" || sourceCatalogLoading || !pendingAddedTablesRef.current?.length) {
      return;
    }
    const names = pendingAddedTablesRef.current;
    pendingAddedTablesRef.current = null;
    void addSourceTables(names);
  }, [tab, sourceCatalogLoading, addSourceTables]);

  /** 数据同步：勾选源表后统计行数 */
  useEffect(() => {
    if (!active || tab !== "dataSync" || sourceCatalogLoading || sourceAddingTables) return;

    const conn = connections.find((c) => c.id === sourceConnId);
    if (!conn || !sourceDb.trim()) return;

    const pending = Array.from(sourceSelected).filter((name) => {
      if (countingRef.current.has(name)) return false;
      const tbl = sourceSnapshot.tables.find((t) => t.name === name);
      return tbl && tbl.rowCount === null;
    });

    if (pending.length === 0) return;

    const scoped = connectionWithDatabase(conn, sourceDb);
    const runId = syncRunIdRef.current;

    for (const name of pending) {
      countingRef.current.add(name);
    }
    setCountingTables((prev) => new Set([...prev, ...pending]));

    void (async () => {
      for (const name of pending) {
        if (syncRunIdRef.current !== runId) break;
        try {
          const count = await countTable(scoped, name, sourceDb);
          if (syncRunIdRef.current !== runId) return;
          setSourceSnapshot((prev) => ({
            ...prev,
            tables: prev.tables.map((t) =>
              t.name === name ? { ...t, rowCount: count } : t,
            ),
          }));
        } catch {
          if (syncRunIdRef.current !== runId) return;
          setSourceSnapshot((prev) => ({
            ...prev,
            tables: prev.tables.map((t) =>
              t.name === name ? { ...t, rowCount: -1 } : t,
            ),
          }));
        } finally {
          countingRef.current.delete(name);
          if (syncRunIdRef.current === runId) {
            setCountingTables((prev) => {
              const next = new Set(prev);
              next.delete(name);
              return next;
            });
          }
        }
      }
    })();

    return () => {
      if (syncRunIdRef.current !== runId) {
        return;
      }
      for (const name of pending) {
        countingRef.current.delete(name);
      }
      setCountingTables((prev) => {
        const next = new Set(prev);
        for (const name of pending) next.delete(name);
        return next;
      });
    };
  }, [active, tab, sourceSideBusy, sourceSnapshot.tables, sourceSelected, sourceConnId, sourceDb, connections]);

  /** 数据同步：已勾选且目标存在的表，补齐目标行数（缓存恢复或目标库切换后） */
  useEffect(() => {
    if (!active || tab !== "dataSync" || targetTablesLoading || !targetConfigured) {
      return;
    }

    const conn = connections.find((c) => c.id === targetConnId);
    if (!conn || !targetDb.trim()) {
      return;
    }

    const pending = Array.from(sourceSelected).filter((name) => {
      if (!targetTableNames.has(name)) {
        return false;
      }
      if (targetCountingRef.current.has(name)) {
        return false;
      }
      return targetRowCounts[name] == null;
    });

    if (pending.length === 0) {
      return;
    }

    const scoped = connectionWithDatabase(conn, targetDb);
    const runId = syncRunIdRef.current;

    for (const name of pending) {
      targetCountingRef.current.add(name);
    }
    setTargetCountingTables((prev) => new Set([...prev, ...pending]));

    void (async () => {
      for (const name of pending) {
        if (syncRunIdRef.current !== runId) {
          break;
        }
        try {
          const count = await countTable(scoped, name, targetDb);
          if (syncRunIdRef.current !== runId) {
            return;
          }
          setTargetRowCounts((prev) => ({ ...prev, [name]: count }));
        } catch {
          if (syncRunIdRef.current !== runId) {
            return;
          }
          setTargetRowCounts((prev) => ({ ...prev, [name]: -1 }));
        } finally {
          targetCountingRef.current.delete(name);
          if (syncRunIdRef.current === runId) {
            setTargetCountingTables((prev) => {
              const next = new Set(prev);
              next.delete(name);
              return next;
            });
          }
        }
      }
    })();

    return () => {
      if (syncRunIdRef.current !== runId) {
        return;
      }
      for (const name of pending) {
        targetCountingRef.current.delete(name);
      }
      setTargetCountingTables((prev) => {
        const next = new Set(prev);
        for (const name of pending) {
          next.delete(name);
        }
        return next;
      });
    };
  }, [
    active,
    tab,
    targetTablesLoading,
    targetConfigured,
    sourceSelected,
    targetTableNames,
    targetRowCounts,
    targetConnId,
    targetDb,
    connections,
  ]);

  /** 已勾选源表：按源/目标行数判定冲突或新增 */
  useEffect(() => {
    if (!active || !targetConfigured || tab !== "dataSync") {
      return;
    }

    if (targetTablesLoading) {
      setTableTargetStatus((prev) => {
        const next: Record<string, TableTargetStatus> = {};
        for (const name of sourceSelected) {
          const status = resolveTableTargetStatusWithAnalysis(
            name,
            targetTableNames,
            sourceSnapshot.tables.find((tbl) => tbl.name === name)?.rowCount,
            targetRowCounts[name],
            tableAnalysis[name],
          );
          if (status) {
            next[name] = status;
          }
        }
        if (JSON.stringify(prev) === JSON.stringify(next)) {
          return prev;
        }
        return next;
      });
      return;
    }

    const sourceCountByName = new Map(
      sourceSnapshot.tables.map((tbl) => [tbl.name, tbl.rowCount] as const),
    );

    setTableTargetStatus((prev) => {
      const next: Record<string, TableTargetStatus> = {};
      for (const name of sourceSelected) {
        const status = resolveTableTargetStatusWithAnalysis(
          name,
          targetTableNames,
          sourceCountByName.get(name),
          targetRowCounts[name],
          tableAnalysis[name],
        );
        if (status) {
          next[name] = status;
        }
      }
      if (JSON.stringify(prev) === JSON.stringify(next)) {
        return prev;
      }
      return next;
    });

    setTableSyncModes((prev) => {
      const next: Record<string, DataSyncModes> = {};
      for (const name of sourceSelected) {
        const status = resolveTableTargetStatusWithAnalysis(
          name,
          targetTableNames,
          sourceCountByName.get(name),
          targetRowCounts[name],
          tableAnalysis[name],
        );
        next[name] = normalizeDataSyncModes(
          prev[name],
          status === "new"
            ? { insert: true, merge: false, delete: false }
            : DEFAULT_DATA_SYNC_MODES,
        );
      }
      if (JSON.stringify(prev) === JSON.stringify(next)) {
        return prev;
      }
      return next;
    });
  }, [
    active,
    sourceSelected,
    sourceSnapshot.tables,
    targetTableNames,
    targetRowCounts,
    targetTablesLoading,
    targetConfigured,
    tab,
    tableAnalysis,
  ]);

  /** 结构同步：勾选源表后对比目标表字段差异（全库后台分析进行中时不覆盖 bg 事件结果） */
  useEffect(() => {
    if (!active || !targetConfigured || tab !== "schemaSync") {
      setSchemaTableDiffs((prev) => (Object.keys(prev).length === 0 ? prev : {}));
      return;
    }
    if (schemaAnalyzing) {
      return;
    }

    const selected = Array.from(sourceSelected);

    if (targetTablesLoading) {
      setSchemaTableDiffs((prev) => {
        const next: Record<string, SchemaTableDiff> = {};
        for (const name of selected) {
          next[name] = { tableName: name, status: "checking", columns: [], indexes: [] };
        }
        return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
      });
      return;
    }

    const targetKey = `${targetConnId}|${targetDb}`;

    setSchemaTableDiffs((prev) => {
      const next: Record<string, SchemaTableDiff> = {};
      for (const name of selected) {
        if (!tableNameExistsInSet(targetTableNames, name, schemaCompareCaseSensitive)) {
          const sourceTable = findTableByName(
            sourceSnapshot.tables,
            name,
            schemaCompareCaseSensitive,
          );
          next[name] = buildNewTableDiff(
            name,
            sourceTable?.columns ?? [],
            sourceTable?.indexes ?? [],
          );
        } else {
          const sourceTable = findTableByName(
            sourceSnapshot.tables,
            name,
            schemaCompareCaseSensitive,
          );
          const sourceKey = sourceTable
            ? sourceTableSchemaSignature(sourceTable.columns, sourceTable.indexes)
            : "";
          if (
            prev[name]?.targetKey === targetKey &&
            prev[name]?.sourceKey === sourceKey &&
            (prev[name].status === "diff" || prev[name].status === "match")
          ) {
            next[name] = prev[name];
          } else {
            next[name] = { tableName: name, status: "checking", columns: [], indexes: [] };
          }
        }
      }
      return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
    });
  }, [
    active,
    tab,
    sourceSelected,
    sourceSnapshot.tables,
    targetTableNames,
    targetTablesLoading,
    targetConfigured,
    targetConnId,
    targetDb,
    schemaCompareCaseSensitive,
    schemaAnalyzing,
  ]);

  const toggleSourceTable = useCallback((name: string) => {
    setSourceExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
    if (tab !== "schemaSync") {
      return;
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const sourceEl = sourceListRef.current;
        const targetEl = targetListRef.current;
        if (!sourceEl || !targetEl) {
          return;
        }
        scrollSyncLockRef.current = true;
        targetEl.scrollTop = sourceEl.scrollTop;
        requestAnimationFrame(() => {
          scrollSyncLockRef.current = false;
        });
      });
    });
  }, [tab]);

  const toggleSourceSelected = useCallback((name: string) => {
    setSourceSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const handleSourceSelectAll = useCallback((select: boolean, visibleNames: string[]) => {
    if (visibleNames.length === 0) {
      return;
    }
    setSourceSelected((prev) => {
      let changed = false;
      const next = new Set(prev);
      if (select) {
        for (const name of visibleNames) {
          if (!next.has(name)) {
            next.add(name);
            changed = true;
          }
        }
      } else {
        for (const name of visibleNames) {
          if (next.delete(name)) {
            changed = true;
          }
        }
      }
      return changed ? next : prev;
    });
  }, []);

  const setTableSyncMode = useCallback(
    (tableName: string, mode: keyof DataSyncModes, enabled: boolean) => {
      setTableSyncModes((prev) => ({
        ...prev,
        [tableName]: {
          ...normalizeDataSyncModes(prev[tableName]),
          [mode]: enabled,
        },
      }));
    },
    [],
  );

  const lockTablesForSync = useCallback((tableNames: string[]) => {
    if (tableNames.length === 0) {
      return;
    }
    setSyncLockedTables((prev) => {
      const next = new Set(prev);
      for (const name of tableNames) {
        next.add(name);
      }
      return next.size === prev.size ? prev : next;
    });
  }, []);

  const tryUnlockSyncTables = useCallback(
    (runningSyncExecuteTables: Set<string>) => {
      setSyncLockedTables((prev) => {
        if (prev.size === 0) {
          return prev;
        }
        let changed = false;
        const next = new Set(prev);
        for (const name of prev) {
          if (runningSyncExecuteTables.has(name)) {
            continue;
          }
          if (postExecuteReanalysisTablesRef.current.has(name)) {
            const status = tableAnalysisRef.current[name]?.status;
            if (
              status === "analyzing" ||
              status === "unchecked" ||
              status === undefined
            ) {
              continue;
            }
            if (status !== "match" && status !== "diff" && status !== "error") {
              continue;
            }
            postExecuteReanalysisTablesRef.current.delete(name);
          }
          next.delete(name);
          changed = true;
        }
        return changed ? next : prev;
      });
    },
    [],
  );

  const sourceSelectedTableNames = useMemo(
    () => Array.from(sourceSelected),
    [sourceSelected],
  );

  const sourceTableColumns = useMemo(() => {
    const map: Record<string, DbColumnMeta[]> = {};
    for (const table of sourceSnapshot.tables) {
      map[table.name] = table.columns;
    }
    return map;
  }, [sourceSnapshot.tables]);

  const sourceTableIndexes = useMemo(() => {
    const map: Record<string, DbIndexMeta[]> = {};
    for (const table of sourceSnapshot.tables) {
      map[table.name] = table.indexes;
    }
    return map;
  }, [sourceSnapshot.tables]);

  const schemaTargetKey = useMemo(
    () => `${targetConnId}|${targetDb}`,
    [targetConnId, targetDb],
  );

  const sourceTableNameSet = useMemo(
    () => new Set(sourceSnapshot.tables.map((table) => table.name)),
    [sourceSnapshot.tables],
  );

  const schemaDiffsForView = useMemo(() => {
    if (tab !== "schemaSync" || !targetConfigured) {
      return schemaTableDiffs;
    }
    const hasCachedDiffs = Object.keys(schemaAnalysisDiffs).length > 0;
    if (schemaAnalyzing) {
      if (hasCachedDiffs) {
        return schemaAnalysisDiffs;
      }
      const names = buildSchemaAlignedTableNames(
        sourceSnapshot,
        targetSnapshot,
        schemaCompareCaseSensitive,
      );
      const next: Record<string, SchemaTableDiff> = {};
      for (const name of names) {
        next[name] = { tableName: name, status: "checking", columns: [], indexes: [] };
      }
      return next;
    }
    if (hasCachedDiffs) {
      return schemaAnalysisDiffs;
    }
    return EMPTY_SCHEMA_TABLE_DIFFS;
  }, [
    tab,
    targetConfigured,
    sourceSnapshot,
    targetSnapshot,
    schemaTargetKey,
    schemaTableDiffs,
    schemaAnalysisDiffs,
    schemaAnalyzing,
    schemaCompareCaseSensitive,
  ]);

  const schemaAlignedTableNames = useMemo(() => {
    if (tab !== "schemaSync" || !targetConfigured) {
      return undefined;
    }
    return buildSchemaAlignedTableNames(
      sourceSnapshot,
      targetSnapshot,
      schemaCompareCaseSensitive,
    );
  }, [
    tab,
    targetConfigured,
    sourceSnapshot,
    targetSnapshot,
    schemaCompareCaseSensitive,
  ]);

  const visibleSchemaAlignedTableNames = useMemo(() => {
    if (!schemaAlignedTableNames) {
      return undefined;
    }
    let names = filterAlignedTableNames(schemaAlignedTableNames, schemaTableSearch);
    if (
      tab === "schemaSync" &&
      targetConfigured &&
      !isSchemaTargetStatusFilterShowAll(schemaTargetStatusFilters)
    ) {
      names = filterAlignedTableNamesByStatus(
        names,
        schemaTargetStatusFilters,
        schemaDiffsForView,
        (name) => tableNameExistsInSet(sourceTableNameSet, name, schemaCompareCaseSensitive),
        (name) =>
          findTableByName(targetSnapshot.tables, name, schemaCompareCaseSensitive) !== undefined,
      );
    }
    return names;
  }, [
    schemaAlignedTableNames,
    schemaTableSearch,
    tab,
    targetConfigured,
    schemaTargetStatusFilters,
    schemaDiffsForView,
    sourceTableNameSet,
    targetSnapshot.tables,
    schemaCompareCaseSensitive,
  ]);

  /** 配置指纹变化时尝试恢复或清空分析缓存 */
  const prevAnalysisConfigKeyRef = useRef<string | null>(null);
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
    setSourceSelected(new Set(config.selectedTables));
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
      selectedTables: Array.from(sourceSelected),
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
    async (tableNames: string[], sqlFilePath: string | null = null) => {
      if (tableNames.length === 0) {
        return;
      }

      const sourceConn = connections.find((c) => c.id === sourceConnId);
      const targetConn = connections.find((c) => c.id === targetConnId);
      if (!sourceConn || !targetConn) {
        return;
      }

      setSubmitting(true);
      setSubmitNotice(null);

      try {
        let bgTaskId: string;
        if (tab === "dataSync") {
          if (!sqlFilePath) {
            setSubmitNotice(t("database.toolbox.executeConfirmMissingSqlFile"));
            return;
          }
          lockTablesForSync(tableNames);
          for (const name of tableNames) {
            submittingTablesRef.current.add(name);
          }
          bgTaskId = await startDbDataSyncSqlExecute(
            targetConn,
            targetDb,
            sqlFilePath,
            tableNames,
          );
          executeTaskTablesRef.current.set(bgTaskId, tableNames);
          ownedDataExecuteTaskIdsRef.current.add(bgTaskId);
        } else {
          bgTaskId = await startDbSchemaSyncExecute(
            sourceConn,
            targetConn,
            sourceDb,
            targetDb,
            tableNames,
            sourceTableColumns,
            sourceTableIndexes,
            targetSnapshot.tables,
            schemaCompareCaseSensitive,
            resolvedSchemaTableNameCase,
            schemaCreateMissingTables,
          );
          executeTaskTablesRef.current.set(bgTaskId, tableNames);
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
      sourceConnId,
      targetConnId,
      sourceDb,
      targetDb,
      tab,
      lockTablesForSync,
      sourceTableColumns,
      tableTargetStatus,
      tableSyncModes,
      sourceTableIndexes,
      targetSnapshot.tables,
      schemaCompareCaseSensitive,
      resolvedSchemaTableNameCase,
      schemaCreateMissingTables,
      recordSyncTaskRun,
      t,
    ],
  );

  const handleExecuteConfirm = useCallback(
    (sqlFilePath: string | null) => {
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

  if (connections.length === 0) {
    return (
      <div className="db-toolbox">
        <ModuleEmptyState
          preset="inbox"
          title={t("database.toolbox.empty.noCapableConnection.title")}
          desc={t("database.toolbox.empty.noCapableConnection.desc")}
        />
      </div>
    );
  }

  return (
    <div className="db-toolbox">
      <div className="db-toolbox-panels" role="tabpanel">
        <DbToolboxSplitLayout
          source={
            <SyncSidePanel
              sideLabel={t("database.toolbox.side.source")}
              connections={connections}
              connectionId={sourceConnId}
              database={sourceDb}
              onConnectionChange={handleSourceConnectionChange}
              onDatabaseChange={setSourceDb}
              databases={sourceDbs}
              databasesLoading={sourceDbsLoading}
              snapshot={sourceSnapshot}
              catalogLoading={tab === "schemaSync" ? sourceSnapshot.loading : sourceCatalogLoading}
              catalogError={sourceCatalogError}
              catalogTableNames={sourceCatalogNames}
              loadingProgress={
                sourceCatalogLoading || sourceSnapshot.loading
                  ? { total: loadTotal, current: loadCurrent, message: loadMessage }
                  : undefined
              }
              tab={tab}
              expandedTables={sourceExpanded}
              onToggleTable={toggleSourceTable}
              selectedTables={sourceSelected}
              onToggleSelect={toggleSourceSelected}
              onSelectAllChange={handleSourceSelectAll}
              onAddTables={tab === "dataSync" ? (names) => void addSourceTables(names) : undefined}
              addingTables={sourceAddingTables}
              countingTables={countingTables}
              alignedTableNames={visibleSchemaAlignedTableNames}
              schemaTableSearch={schemaTableSearch}
              onSchemaTableSearchChange={setSchemaTableSearch}
              schemaStatusFilters={tab === "schemaSync" ? schemaTargetStatusFilters : undefined}
              schemaCaseSensitive={schemaCaseSensitive}
              scrollListRef={sourceListRef}
            />
          }
          target={
            <SyncSidePanel
              sideLabel={t("database.toolbox.side.target")}
              tableListMode="targetSync"
              connections={connections}
              connectionId={targetConnId}
              database={targetDb}
              onConnectionChange={handleTargetConnectionChange}
              onDatabaseChange={setTargetDb}
              databases={targetDbs}
              databasesLoading={targetDbsLoading}
              snapshot={tab === "schemaSync" ? targetSnapshot : EMPTY_SNAPSHOT}
              tab={tab}
              expandedTables={sourceExpanded}
              onToggleTable={toggleSourceTable}
              selectedTables={tab === "schemaSync" ? sourceSelected : new Set()}
              onToggleSelect={() => {}}
              sourceSelectedTableNames={sourceSelectedTableNames}
              targetConfigured={targetConfigured}
              targetTablesLoading={tab === "schemaSync" ? targetSnapshot.loading : targetTablesLoading}
              tableTargetStatus={tableTargetStatus}
              tableSyncModes={tableSyncModes}
              onSyncModeChange={setTableSyncMode}
              syncLockedTables={syncLockedTables}
              canSubmitTable={canSubmitTable}
              onSyncTableSubmit={(tableName) => void handleSingleTableSubmit(tableName)}
              schemaTableDiffs={schemaDiffsForView}
              tableAnalysis={tableAnalysis}
              conflictDetailTable={conflictDetailTable}
              onViewConflictDetail={handleViewConflictDetail}
              schemaStatusFilters={schemaTargetStatusFilters}
              onSchemaStatusFiltersChange={setSchemaTargetStatusFilters}
              sourceTableColumns={sourceTableColumns}
              sourceTableIndexes={sourceTableIndexes}
              alignedTableNames={visibleSchemaAlignedTableNames}
              targetSnapshot={targetSnapshot}
              sourceTableNames={sourceTableNameSet}
              schemaCaseSensitive={schemaCaseSensitive}
              scrollListRef={targetListRef}
              onAnalyze={
                tab === "schemaSync" && targetConfigured ? handleAnalyze : undefined
              }
              analyzeBusy={tab === "schemaSync" ? analyzeBusy : undefined}
              hasAnalysisResult={tab === "schemaSync" ? hasAnalysisResult : undefined}
              onAnalyzeTable={
                tab === "dataSync" && targetConfigured ? handleAnalyzeTable : undefined
              }
              analyzingTables={tab === "dataSync" ? dataSyncAnalyzingTables : undefined}
            />
          }
        />
      </div>

      <footer className="db-toolbox-footer">
        <div className="db-toolbox-footer__start">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            title={t("database.toolbox.settingsTitle")}
            aria-label={t("database.toolbox.settingsTitle")}
            onClick={() => setTaskSettingsOpen(true)}
          >
            <IconSettings size={18} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            title={t("database.toolbox.scriptPreviewTitle")}
            aria-label={t("database.toolbox.scriptPreviewTitle")}
            disabled={!scriptPreviewInput}
            onClick={() => setTaskScriptPreviewOpen(true)}
          >
            <IconFile size={18} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            title={t("database.toolbox.historyTitle")}
            aria-label={t("database.toolbox.historyTitle")}
            onClick={() => setTaskHistoryOpen(true)}
          >
            <IconClock size={18} />
          </Button>
        </div>
        <div className="db-toolbox-footer__meta">
          {submitNotice ? (
            <span className="db-toolbox-footer__notice">{submitNotice}</span>
          ) : dataSyncProgressLabel ? (
            <span className="db-toolbox-footer__hint db-toolbox-footer__hint--progress">
              {dataSyncProgressLabel}
            </span>
          ) : submitDisabledReason && !canSubmit ? (
            <span className="db-toolbox-footer__hint">{submitDisabledReason}</span>
          ) : hasAnalysisResult && lastAnalysisTimeLabel ? (
            <span className="db-toolbox-footer__hint">
              {t("database.toolbox.side.analyzedAt", { time: lastAnalysisTimeLabel })}
            </span>
          ) : (
            <span className="db-toolbox-footer__hint">
              {tab === "dataSync"
                ? t("database.toolbox.submitHintData", { count: sourceSelected.size })
                : t("database.toolbox.submitHintSchema", { count: sourceSelected.size })}
            </span>
          )}
        </div>
        <div className="db-toolbox-footer__actions">
          {tab === "dataSync" && targetConfigured && (
            <Button
              type="button"
              variant="ghost"
              disabled={!canAnalyzeAll}
              title={
                analyzeAllDisabledReason ??
                (hasDataAnalysisResult
                  ? t("database.toolbox.reanalyzeAllHint")
                  : t("database.toolbox.analyzeAllHint"))
              }
              onClick={() => void handleDataAnalyze()}
            >
              {syncAnalysisBusy
                ? t("database.toolbox.side.analysisAnalyzing")
                : hasDataAnalysisResult
                  ? t("database.toolbox.reanalyzeAll")
                  : t("database.toolbox.analyzeAll")}
            </Button>
          )}
          <Button
            type="button"
            variant="default"
            disabled={!canSubmit || submitting}
            onClick={() => void handleSubmit()}
          >
            {t("database.toolbox.submit")}
          </Button>
        </div>
      </footer>

      <SyncTaskSettingsDialog
        open={taskSettingsOpen}
        onClose={() => setTaskSettingsOpen(false)}
        tab={tab}
        taskName={taskName}
        schemaCaseSensitive={schemaCaseSensitive}
        schemaTableNameCase={resolvedSchemaTableNameCase}
        schemaCreateMissingTables={schemaCreateMissingTables}
        ignoredFields={ignoredFields}
        onApply={handleApplyTaskSettings}
      />

      <SubWindow
        open={taskHistoryOpen}
        title={t("database.toolbox.taskHistoryTitleNamed", {
          name: taskName.trim() || resolveTaskName(),
        })}
        onClose={() => setTaskHistoryOpen(false)}
        className="db-toolbox-history-subwindow"
        widthRatio={0.62}
        heightRatio={0.68}
      >
        <SyncTaskHistoryPanel
          taskId={syncTaskId}
          taskName={taskName.trim() || resolveTaskName()}
        />
      </SubWindow>

      <SubWindow
        open={taskScriptPreviewOpen}
        title={t("database.toolbox.scriptPreviewTitleNamed", {
          name: taskName.trim() || resolveTaskName(),
        })}
        onClose={() => setTaskScriptPreviewOpen(false)}
        className="db-toolbox-script-preview-subwindow"
        widthRatio={0.72}
        heightRatio={0.72}
      >
        <SyncTaskScriptPreviewPanel input={taskScriptPreviewOpen ? scriptPreviewInput : null} />
      </SubWindow>

      <SyncTaskExecuteConfirmDialog
        open={executeConfirmSnapshot !== null}
        title={executeConfirmTitle}
        input={executeConfirmSnapshot}
        confirming={submitting}
        onClose={closeExecuteConfirmDialog}
        onConfirm={handleExecuteConfirm}
      />

      <SubWindow
        open={conflictDetailTable !== null}
        title={
          conflictDetailTable
            ? t("database.toolbox.side.rowDiffTitle", { table: conflictDetailTable })
            : t("database.toolbox.side.rowDiffTitleFallback")
        }
        onClose={() => setConflictDetailTable(null)}
        className="db-toolbox-conflict-subwindow"
        widthRatio={0.82}
        heightRatio={0.72}
      >
        {conflictDetailTable ? (
          <TableRowDiffPanel
            tableName={conflictDetailTable}
            analysis={tableAnalysis[conflictDetailTable]}
            columns={sourceTableColumns[conflictDetailTable] ?? []}
            ignoredColumns={conflictDetailIgnoredColumns}
          />
        ) : null}
      </SubWindow>
    </div>
  );
}
