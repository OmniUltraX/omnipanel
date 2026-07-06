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
  startDbDataSyncExecute,
  startDbSchemaSyncExecute,
  useDbSyncBackgroundTaskEvents,
} from "./useDbSyncBackgroundTasks";
import type { BackgroundTaskInfo } from "../../../stores/backgroundTaskStore";
import {
  countTable,
  introspectSchema,
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
import type { SyncTaskSqlPreviewInput } from "./syncTaskSqlPreview";
import {
  buildSchemaAlignedTableNames,
  buildSchemaDiffsFromSnapshots,
  filterAlignedTableNames,
  filterAlignedTableNamesByStatus,
  findTableByName,
  isSchemaCaseSensitive,
  tableNameExistsInSet,
  isSchemaSyncSourceTableMissingInTarget,
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
  sourceTableSchemaSignature,
  type SchemaTableDiff,
} from "./schemaDiff";
import { TableRowDiffPanel } from "./TableRowDiffPanel";
import { useDbSyncTaskStore } from "../../../stores/dbSyncTaskStore";
import {
  connectionWithDatabase,
  resolveDataSyncConflictStatus,
  type DataAnalysisResult,
  type DataSyncStrategy,
  type SyncSideSnapshot,
  type SyncTableInfo,
  type SyncTaskAnalysisStatus,
  type SchemaTableNameCase,
  type SyncTaskConfig,
  type TableTargetStatus,
  type ToolboxTabId,
  type SchemaTargetRowStatus,
  normalizeSchemaTargetStatusFilters,
  isSchemaTargetStatusFilterShowAll,
} from "./types";

const EMPTY_SNAPSHOT: SyncSideSnapshot = { tables: [], loading: false, error: null };

/** 逐条比对的行数门槛 */
const LARGE_TABLE_ROW_THRESHOLD = 10_000;

const EXECUTE_TASK_KINDS = new Set(["dbDataSyncExecute", "dbSchemaSyncExecute"]);
const TERMINAL_EXECUTE_STATUSES = new Set(["completed", "failed"]);

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
  const sourceListRef = useRef<HTMLDivElement>(null);
  const targetListRef = useRef<HTMLDivElement>(null);
  const scrollSyncLockRef = useRef(false);
  const autoSavePausedRef = useRef(false);
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sourceSelected, setSourceSelected] = useState<Set<string>>(() => new Set());
  const [tableTargetStatus, setTableTargetStatus] = useState<Record<string, TableTargetStatus>>({});
  const [tableSyncStrategies, setTableSyncStrategies] = useState<Record<string, DataSyncStrategy>>({});
  const [tableAnalysis, setTableAnalysis] = useState<Record<string, DataAnalysisResult>>({});
  const [conflictDetailTable, setConflictDetailTable] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitNotice, setSubmitNotice] = useState<string | null>(null);
  const [taskSettingsOpen, setTaskSettingsOpen] = useState(false);
  const [taskHistoryOpen, setTaskHistoryOpen] = useState(false);
  const [taskScriptPreviewOpen, setTaskScriptPreviewOpen] = useState(false);
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
  const analyzeRequestedRef = useRef(false);
  const lastAnalysisConfigKeyRef = useRef("");
  const lastAnalyzedSelectionRef = useRef<Set<string>>(new Set());
  const bgDataTaskIdRef = useRef<string | null>(null);
  const bgSchemaTaskIdRef = useRef<string | null>(null);
  const dataAnalysisStartedAtRef = useRef<number | null>(null);

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
  const cachedAnalysisLoadedKeyRef = useRef<string | null>(null);

  const activeRef = useRef(active);
  activeRef.current = active;
  const processedExecuteBgTaskIdsRef = useRef(new Set<string>());
  const pendingPostExecuteAnalysisRef = useRef(false);
  const handlePostExecuteAnalyzeRef = useRef<() => void>(() => {});

  const targetConfigured = Boolean(targetConnId && targetDb.trim());
  const schemaCompareCaseSensitive = isSchemaCaseSensitive(schemaCaseSensitive);
  const resolvedSchemaTableNameCase = resolveSchemaTableNameCase(schemaTableNameCase);

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
    ],
  );

  const restoreAnalysisFromConfig = useCallback(
    (config: SyncTaskConfig): boolean => {
      const key = buildSyncAnalysisConfigKey({
        tab,
        sourceConnId: config.sourceConnId,
        sourceDb: config.sourceDb,
        targetConnId: config.targetConnId,
        targetDb: config.targetDb,
        schemaCaseSensitive: config.schemaCaseSensitive,
        schemaTableNameCase: resolveSchemaTableNameCase(config.schemaTableNameCase),
        schemaCreateMissingTables: config.schemaCreateMissingTables,
      });
      const cached = pickAnalysisCacheForRestore(config.analysisCache, key);
      if (!cached) {
        setSchemaAnalysisDiffs({});
        setAnalysisAnalyzedAt(null);
        setTableAnalysis({});
        setTargetRowCounts({});
        lastAnalyzedSelectionRef.current = new Set();
        lastAnalysisConfigKeyRef.current = "";
        return false;
      }
      if (cached.schemaDiffs && tab === "schemaSync") {
        setSchemaAnalysisDiffs(cached.schemaDiffs);
      } else {
        setSchemaAnalysisDiffs({});
      }
      if (cached.tableAnalysis && tab === "dataSync") {
        const sanitized: Record<string, DataAnalysisResult> = {};
        for (const [name, result] of Object.entries(cached.tableAnalysis)) {
          if (result.status !== "analyzing") {
            sanitized[name] = result;
          }
        }
        setTableAnalysis(sanitized);
        lastAnalyzedSelectionRef.current = new Set(Object.keys(sanitized));
      } else if (tab === "dataSync") {
        setTableAnalysis({});
        lastAnalyzedSelectionRef.current = new Set();
      }
      if (cached.targetRowCounts && tab === "dataSync") {
        setTargetRowCounts(cached.targetRowCounts);
      } else if (tab === "dataSync") {
        setTargetRowCounts({});
      }
      setAnalysisAnalyzedAt(cached.analyzedAt);
      lastAnalysisConfigKeyRef.current = key;
      return true;
    },
    [tab, syncTaskId],
  );

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
    if (tab !== "schemaSync") {
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
  }, [tab, targetConfigured, sourceSnapshot.loading, targetSnapshot.loading]);

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
    if (!active) {
      return;
    }
    // 任务加载期间会恢复 analysisCache 中的 targetRowCounts，此处跳过清空避免目标侧一直「检测中」
    if (taskLoadRef.current) {
      return;
    }
    syncRunIdRef.current += 1;
    targetCountingRef.current.clear();
    setTargetCountingTables(new Set());
    setTargetRowCounts({});
  }, [active, targetConnId, targetDb]);

  const loadSideSnapshot = useCallback(
    async (connId: string, database: string, mode: ToolboxTabId) => {
      const conn = connections.find((c) => c.id === connId);
      if (!conn || !database.trim()) {
        setSourceSnapshot(EMPTY_SNAPSHOT);
        return;
      }

      resetLoadProgress(1, t("database.toolbox.loading.schema"));
      setSourceSnapshot({ tables: [], loading: true, error: null });
      try {
        const scoped = connectionWithDatabase(conn, database);
        const result = await introspectSchema(scoped, database);
        const tables: SyncTableInfo[] = result.tables.map((tbl) => ({
          name: tbl.name,
          columns: tbl.columns,
          indexes: tbl.indexes ?? [],
          rowCount: mode === "dataSync" ? null : 0,
        }));

        advanceLoadProgress(1, t("database.toolbox.loading.schemaDone", { count: tables.length }));

        tables.sort((a, b) => a.name.localeCompare(b.name));
        setSourceSnapshot({ tables, loading: false, error: null });
      } catch (e) {
        setSourceSnapshot({
          tables: [],
          loading: false,
          error: typeof e === "string" ? e : String(e),
        });
      }
    },
    [connections, resetLoadProgress, advanceLoadProgress, t],
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
        void loadSideSnapshot(config.sourceConnId, config.sourceDb, tab);
      }
      if (tab === "schemaSync") {
        void loadTargetSnapshot();
      } else {
        void loadTargetTableNames();
      }
    },
    [tab, syncTaskId, loadSideSnapshot, loadTargetSnapshot, loadTargetTableNames],
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
      setTableTargetStatus({});
      setTableSyncStrategies({});
      setConflictDetailTable(null);
      setSubmitNotice(null);
      analyzingRef.current.clear();
      lastAnalyzedSelectionRef.current = new Set();
    }
    void loadSideSnapshot(sourceConnId, sourceDb, tab);
  }, [active, sourceConnId, sourceDb, tab, loadSideSnapshot]);

  /** 结构同步：源表加载完成后默认全选 */
  useEffect(() => {
    if (!active || tab !== "schemaSync" || sourceSnapshot.loading || taskLoadRef.current) {
      return;
    }
    if (sourceSnapshot.tables.length === 0) {
      return;
    }
    setSourceSelected((prev) => {
      if (prev.size > 0) {
        return prev;
      }
      return new Set(sourceSnapshot.tables.map((table) => table.name));
    });
  }, [active, tab, sourceSnapshot.loading, sourceSnapshot.tables, sourceConnId, sourceDb]);

  /** 数据同步：勾选源表后统计行数 */
  useEffect(() => {
    if (!active || tab !== "dataSync" || sourceSnapshot.loading) return;

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
  }, [active, tab, sourceSnapshot.loading, sourceSnapshot.tables, sourceSelected, sourceConnId, sourceDb, connections]);

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
      setTableTargetStatus({});
      setTableSyncStrategies({});
      return;
    }

    if (targetTablesLoading) {
      setTableTargetStatus(() => {
        const next: Record<string, TableTargetStatus> = {};
        for (const name of sourceSelected) {
          next[name] = "checking";
        }
        return next;
      });
      return;
    }

    const sourceCountByName = new Map(
      sourceSnapshot.tables.map((tbl) => [tbl.name, tbl.rowCount] as const),
    );

    setTableTargetStatus(() => {
      const next: Record<string, TableTargetStatus> = {};
      for (const name of sourceSelected) {
        const status = resolveDataSyncConflictStatus(
          name,
          targetTableNames,
          sourceCountByName.get(name),
          targetRowCounts[name],
        );
        if (status) {
          next[name] = status;
        }
      }
      return next;
    });

    setTableSyncStrategies((prev) => {
      const next: Record<string, DataSyncStrategy> = {};
      for (const name of sourceSelected) {
        const status = resolveDataSyncConflictStatus(
          name,
          targetTableNames,
          sourceCountByName.get(name),
          targetRowCounts[name],
        );
        if (status === "conflict") {
          next[name] = prev[name] ?? "rewrite";
        }
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
  ]);

  /** 结构同步：勾选源表后对比目标表字段差异 */
  useEffect(() => {
    if (!active || !targetConfigured || tab !== "schemaSync") {
      setSchemaTableDiffs({});
      return;
    }

    const selected = Array.from(sourceSelected);

    if (targetTablesLoading) {
      setSchemaTableDiffs(() => {
        const next: Record<string, SchemaTableDiff> = {};
        for (const name of selected) {
          next[name] = { tableName: name, status: "checking", columns: [], indexes: [] };
        }
        return next;
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
      return next;
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

  const selectSourceAllTables = useCallback((tableNames: string[], selected: boolean) => {
    setSourceSelected((prev) => {
      const next = new Set(prev);
      for (const name of tableNames) {
        if (selected) next.add(name);
        else next.delete(name);
      }
      return next;
    });
  }, []);

  const setTableSyncStrategy = useCallback((tableName: string, strategy: DataSyncStrategy) => {
    setTableSyncStrategies((prev) => ({ ...prev, [tableName]: strategy }));
  }, []);

  const sourceSelectedTableNames = useMemo(
    () => Array.from(sourceSelected),
    [sourceSelected],
  );

  const sourceSelectedInTarget = useMemo(
    () => sourceSelectedTableNames.filter((name) => targetTableNames.has(name)),
    [sourceSelectedTableNames, targetTableNames],
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
        true,
        {},
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
    return {};
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
      true,
      schemaDiffsForView,
      schemaCompareCaseSensitive,
    );
  }, [
    tab,
    targetConfigured,
    sourceSnapshot,
    targetSnapshot,
    schemaDiffsForView,
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

  /** 结构同步：用户点击「分析/重新分析」且快照就绪后计算差异 */
  useEffect(() => {
    if (!active || tab !== "schemaSync" || !targetConfigured) {
      return;
    }
    if (!analyzeRequestedRef.current) {
      return;
    }
    if (sourceSnapshot.loading || targetSnapshot.loading) {
      return;
    }
    if (sourceSnapshot.tables.length === 0 && targetSnapshot.tables.length === 0) {
      analyzeRequestedRef.current = false;
      setSchemaAnalyzing(false);
      return;
    }

    const diffs = buildSchemaDiffsFromSnapshots(
      sourceSnapshot,
      targetSnapshot,
      schemaTargetKey,
      schemaCompareCaseSensitive,
    );
    setSchemaAnalysisDiffs(diffs);
    const analyzedAt = Date.now();
    setAnalysisAnalyzedAt(analyzedAt);
    lastAnalysisConfigKeyRef.current = analysisConfigKey;
    analyzeRequestedRef.current = false;
    setSchemaAnalyzing(false);

    const analyzedTables = Object.keys(diffs).filter(
      (name) => sourceSelected.has(name) || diffs[name]?.status === "targetOnly",
    );
    const tableNames =
      analyzedTables.length > 0
        ? analyzedTables.sort((a, b) => a.localeCompare(b))
        : Array.from(sourceSelected).sort((a, b) => a.localeCompare(b));
    if (tableNames.length > 0 && syncTaskId) {
      const diffCount = tableNames.filter((name) => {
        const status = diffs[name]?.status;
        return status === "diff" || status === "new";
      }).length;
      const errorCount = tableNames.filter((name) => diffs[name]?.status === "error").length;
      const matchCount = tableNames.filter((name) => diffs[name]?.status === "match").length;
      let status: SyncTaskAnalysisStatus = "completed";
      if (errorCount === tableNames.length) {
        status = "failed";
      } else if (errorCount > 0) {
        status = "partial";
      }
      addAnalysisRecord(syncTaskId, {
        id: `sync-analysis:${analyzedAt}:${Math.random().toString(36).slice(2, 8)}`,
        kind: tab,
        status,
        tableCount: tableNames.length,
        tableNames,
        startedAt: analyzedAt,
        finishedAt: analyzedAt,
        summary: t("database.toolbox.historyAnalysisSummarySchema", {
          diff: diffCount,
          match: matchCount,
          error: errorCount,
        }),
        configKey: analysisConfigKey,
      });
    }
  }, [
    active,
    tab,
    targetConfigured,
    sourceSnapshot.loading,
    targetSnapshot.loading,
    sourceSnapshot.tables,
    targetSnapshot.tables,
    analysisConfigKey,
    schemaTargetKey,
    schemaCompareCaseSensitive,
    sourceSelected,
    syncTaskId,
    addAnalysisRecord,
    t,
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
      restoreAnalysisFromConfig(task.config);
      return;
    }

    setSchemaAnalysisDiffs({});
    setAnalysisAnalyzedAt(null);
    lastAnalysisConfigKeyRef.current = "";
    analyzeRequestedRef.current = false;
    if (tab === "dataSync") {
      setTableAnalysis({});
      setTargetRowCounts({});
      lastAnalyzedSelectionRef.current = new Set();
    }
  }, [analysisConfigKey, syncTaskId, tab, restoreAnalysisFromConfig]);

  /** 面板重新激活时补恢复分析缓存（任务已加载完成、配置指纹匹配） */
  useEffect(() => {
    if (!active || !syncTaskId || taskLoadRef.current || pendingLoad) {
      return;
    }
    if (loadedForSyncTaskRef.current !== syncTaskId) {
      return;
    }
    const task = syncTasks.find((item) => item.id === syncTaskId);
    if (!task) {
      return;
    }
    const cached = pickAnalysisCacheForRestore(task.config.analysisCache, analysisConfigKey);
    if (!cached) {
      return;
    }
    if (analysisAnalyzedAt === null || lastAnalysisConfigKeyRef.current !== analysisConfigKey) {
      restoreAnalysisFromConfig(task.config);
    }
  }, [
    active,
    syncTaskId,
    pendingLoad,
    syncTasks,
    analysisConfigKey,
    analysisAnalyzedAt,
    restoreAnalysisFromConfig,
  ]);

  const handleBgTargetRowCount = useCallback((table: string, count: number | null) => {
    setTargetRowCounts((prev) => ({ ...prev, [table]: count }));
  }, []);

  const handleBgTableAnalysis = useCallback((table: string, result: DataAnalysisResult) => {
    analyzingRef.current.delete(table);
    setTableAnalysis((prev) => ({ ...prev, [table]: result }));
  }, []);

  const handleBgSchemaDiff = useCallback((table: string, diff: SchemaTableDiff) => {
    schemaFetchingRef.current.delete(table);
    setSchemaTableDiffs((prev) => ({ ...prev, [table]: diff }));
  }, []);

  const handleBgAnalysisPending = useCallback((tables: string[], pending: boolean) => {
    for (const name of tables) {
      if (pending) {
        analyzingRef.current.add(name);
        setTableAnalysis((prev) => ({ ...prev, [name]: { status: "analyzing" } }));
      } else {
        analyzingRef.current.delete(name);
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

  useDbSyncBackgroundTaskEvents({
    active,
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
      await cancelDbBackgroundTask(bgDataTaskIdRef.current);
      bgDataTaskIdRef.current = null;

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
        );
        if (syncRunIdRef.current !== runId) {
          await cancelDbBackgroundTask(taskId);
          return;
        }
        bgDataTaskIdRef.current = taskId;
      } catch (e) {
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
      setSchemaTableDiffs((prev) => {
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
    if (!active) return;

    let dispose: (() => void) | undefined;
    listen<BackgroundTaskInfo>("bg-task-update", (event) => {
      const task = event.payload;
      if (task.module !== "database" || task.status !== "cancelled") return;

      if (task.id === bgDataTaskIdRef.current) {
        bgDataTaskIdRef.current = null;
        applyAnalysisCancelled("data");
      }
      if (task.id === bgSchemaTaskIdRef.current) {
        bgSchemaTaskIdRef.current = null;
        applyAnalysisCancelled("schema");
      }
    })
      .then((fn) => {
        dispose = fn;
      })
      .catch(() => {});

    return () => {
      dispose?.();
    };
  }, [active, applyAnalysisCancelled]);

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

  const syncCompareBusy =
    (tab === "dataSync" && syncAnalysisBusy) || (tab === "schemaSync" && schemaSyncBusy);

  // 勾选即触发逐条比对：仅在 dataSync tab 下，对源侧新勾选且目标库中存在的表做处理。
  useEffect(() => {
    if (!active || tab !== "dataSync" || !targetConfigured || targetTablesLoading) return;
    if (taskLoadRef.current || autoSavePausedRef.current) return;

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
    t,
  ]);

  const canSubmit = useMemo(() => {
    if (sourceSelected.size === 0) return false;
    if (!targetConfigured || !sourceDb.trim() || !targetDb.trim()) return false;
    if (tab === "dataSync") {
      if (syncAnalysisBusy) return false;
      return true;
    }
    if (schemaSyncBusy) return false;
    return true;
  }, [
    sourceSelected.size,
    targetConfigured,
    sourceDb,
    targetDb,
    tab,
    syncAnalysisBusy,
    schemaSyncBusy,
  ]);

  const submitDisabledReason = useMemo(() => {
    if (sourceSelected.size === 0) return t("database.toolbox.submitHintNoSelection");
    if (!targetConfigured) return t("database.toolbox.submitHintNoTarget");
    if (!sourceDb.trim() || !targetDb.trim()) return t("database.toolbox.submitHintNoDatabase");
    if (tab === "dataSync" && syncAnalysisBusy) return t("database.toolbox.submitHintBusy");
    if (tab === "schemaSync" && schemaSyncBusy) return t("database.toolbox.submitHintBusy");
    return null;
  }, [
    sourceSelected.size,
    targetConfigured,
    sourceDb,
    targetDb,
    tab,
    syncAnalysisBusy,
    schemaSyncBusy,
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
    analyzeRequestedRef.current = false;
    lastAnalysisConfigKeyRef.current = "";
    prevAnalysisConfigKeyRef.current = null;
    setCountingTables(new Set());
    setTargetCountingTables(new Set());
    setTargetRowCounts({});
    setSourceSelected(new Set());
    setSourceExpanded(new Set());
    setTableSyncStrategies({});
    setSchemaCaseSensitive(config.schemaCaseSensitive ?? true);
    setSchemaTableNameCase(resolveSchemaTableNameCase(config.schemaTableNameCase));
    setSchemaCreateMissingTables(config.schemaCreateMissingTables !== false);
    setSchemaTargetStatusFilters(normalizeSchemaTargetStatusFilters(config.schemaTargetStatusFilter));
    setSchemaTableSearch(config.schemaTableSearch ?? "");
    restoreAnalysisFromConfig(config);
    prevAnalysisConfigKeyRef.current = buildSyncAnalysisConfigKey({
      tab,
      sourceConnId: config.sourceConnId,
      sourceDb: config.sourceDb,
      targetConnId: config.targetConnId,
      targetDb: config.targetDb,
      schemaCaseSensitive: config.schemaCaseSensitive,
      schemaTableNameCase: resolveSchemaTableNameCase(config.schemaTableNameCase),
      schemaCreateMissingTables: config.schemaCreateMissingTables,
    });
    taskLoadRef.current = { config, runAfterLoad };
    prevSourceConnIdRef.current = config.sourceConnId;
    prevTargetConnIdRef.current = config.targetConnId;
    prevSourceSideKeyRef.current = `${tab}\0${config.sourceConnId}\0${(config.sourceDb ?? "").trim()}`;
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
  }, [tab, restoreAnalysisFromConfig, syncTaskId, loadDatabases]);

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
    const selectedNames =
      config.selectedTables.length > 0
        ? config.selectedTables
        : tab === "schemaSync"
          ? sourceSnapshot.tables.map((table) => table.name)
          : [];
    setSourceSelected(new Set(selectedNames));
    setSourceExpanded(new Set(config.expandedTables ?? []));
    setTableSyncStrategies({ ...(config.tableSyncStrategies ?? {}) });
    if (tab === "dataSync") {
      const cacheKey = buildSyncAnalysisConfigKey({
        tab,
        sourceConnId: config.sourceConnId,
        sourceDb: config.sourceDb,
        targetConnId: config.targetConnId,
        targetDb: config.targetDb,
        schemaCaseSensitive: config.schemaCaseSensitive,
      });
      const cached = pickAnalysisCacheForRestore(config.analysisCache, cacheKey);
      if (cached?.tableAnalysis) {
        const selectedSet = new Set(selectedNames);
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
      expandedTables: Array.from(sourceExpanded),
      tableSyncStrategies: { ...tableSyncStrategies },
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
    sourceExpanded,
    tableSyncStrategies,
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

  const tableSyncStrategiesKey = useMemo(
    () => JSON.stringify(tableSyncStrategies),
    [tableSyncStrategies],
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
    !sourceSnapshot.loading &&
    !targetSnapshot.loading &&
    schemaExpandedTableNames.length > 0;

  useSchemaRowHeightSync(
    sourceListRef,
    targetListRef,
    schemaExpandedTableNames,
    schemaRowHeightSyncEnabled,
    schemaRowHeightSyncKey,
  );

  useEffect(() => {
    if (tab !== "schemaSync" || sourceExpanded.size === 0) {
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
  }, [tab, expandedTablesKey, visibleSchemaAlignedTableNames]);

  const tableAnalysisKey = useMemo(
    () => JSON.stringify(tableAnalysis),
    [tableAnalysis],
  );

  const targetRowCountsKey = useMemo(
    () => JSON.stringify(targetRowCounts),
    [targetRowCounts],
  );

  const handleSchemaAnalyze = useCallback(() => {
    analyzeRequestedRef.current = true;
    syncRunIdRef.current += 1;
    setSchemaAnalyzing(true);
    void loadSideSnapshot(sourceConnId, sourceDb, tab);
    void loadTargetSnapshot();
  }, [loadSideSnapshot, loadTargetSnapshot, sourceConnId, sourceDb, tab]);

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

  const handlePostExecuteAnalyze = useCallback(() => {
    if (tab === "schemaSync") {
      handleSchemaAnalyze();
      return;
    }
    runDataSyncAnalysis({ skipLargeTableConfirm: true });
  }, [tab, handleSchemaAnalyze, runDataSyncAnalysis]);

  handlePostExecuteAnalyzeRef.current = handlePostExecuteAnalyze;

  useEffect(() => {
    processedExecuteBgTaskIdsRef.current.clear();
  }, [syncTaskId]);

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
      if (processedExecuteBgTaskIdsRef.current.has(task.id)) {
        return;
      }

      const runs = useDbSyncTaskStore.getState().runHistory[syncTaskId] ?? [];
      const matched = runs.some((run) => run.bgTaskId === task.id && run.kind === tab);
      if (!matched) {
        return;
      }

      processedExecuteBgTaskIdsRef.current.add(task.id);
      if (activeRef.current) {
        queueMicrotask(() => {
          handlePostExecuteAnalyzeRef.current();
        });
      } else {
        pendingPostExecuteAnalysisRef.current = true;
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

  useEffect(() => {
    if (!active || !pendingPostExecuteAnalysisRef.current) {
      return;
    }
    if (taskLoadRef.current || sourceSnapshot.loading || targetSnapshot.loading) {
      return;
    }
    if (tab === "dataSync" && targetTablesLoading) {
      return;
    }
    pendingPostExecuteAnalysisRef.current = false;
    handlePostExecuteAnalyze();
  }, [
    active,
    tab,
    sourceSnapshot.loading,
    targetSnapshot.loading,
    targetTablesLoading,
    handlePostExecuteAnalyze,
  ]);

  const handleAnalyze =
    tab === "schemaSync" ? handleSchemaAnalyze : handleDataAnalyze;

  const analyzeBusy =
    tab === "schemaSync" ? schemaAnalyzing : syncAnalysisBusy;

  const hasAnalysisResult =
    tab === "schemaSync" ? hasSchemaAnalysisResult : hasDataAnalysisResult;

  const lastAnalysisTimeLabel = useMemo(
    () => (analysisAnalyzedAt !== null ? new Date(analysisAnalyzedAt).toLocaleString() : null),
    [analysisAnalyzedAt],
  );

  const sourceRowCountsForPreview = useMemo(() => {
    const counts: Record<string, number | null> = {};
    for (const table of sourceSnapshot.tables) {
      counts[table.name] = table.rowCount;
    }
    return counts;
  }, [sourceSnapshot.tables]);

  const scriptPreviewInput = useMemo((): SyncTaskSqlPreviewInput | null => {
    const sourceConn = connections.find((c) => c.id === sourceConnId);
    const targetConn = connections.find((c) => c.id === targetConnId);
    if (!sourceConn || !targetConn || !sourceDb.trim() || !targetDb.trim()) {
      return null;
    }
    const tableNames = Array.from(sourceSelected).sort((a, b) => a.localeCompare(b));
    if (tableNames.length === 0) {
      return null;
    }
    return {
      tab,
      sourceConn,
      sourceDb,
      targetConn,
      targetDb,
      tableNames,
      tableTargetStatus,
      tableSyncStrategies,
      sourceTableColumns,
      sourceTableIndexes,
      schemaAnalysisDiffs: tab === "schemaSync" ? schemaDiffsForView : schemaAnalysisDiffs,
      sourceRowCounts: sourceRowCountsForPreview,
      targetTables: targetSnapshot.tables,
      schemaCaseSensitive: schemaCompareCaseSensitive,
      schemaTableNameCase: resolvedSchemaTableNameCase,
      schemaCreateMissingTables,
    };
  }, [
    connections,
    sourceConnId,
    targetConnId,
    sourceDb,
    targetDb,
    sourceSelected,
    tab,
    tableTargetStatus,
    tableSyncStrategies,
    sourceTableColumns,
    sourceTableIndexes,
    schemaAnalysisDiffs,
    schemaDiffsForView,
    sourceRowCountsForPreview,
    targetSnapshot.tables,
    schemaCompareCaseSensitive,
    resolvedSchemaTableNameCase,
    schemaCreateMissingTables,
  ]);

  const conflictDetailSourceConn = useMemo(() => {
    const conn = connections.find((c) => c.id === sourceConnId);
    return conn && sourceDb.trim() ? connectionWithDatabase(conn, sourceDb) : undefined;
  }, [connections, sourceConnId, sourceDb]);

  const conflictDetailTargetConn = useMemo(() => {
    const conn = connections.find((c) => c.id === targetConnId);
    return conn && targetDb.trim() ? connectionWithDatabase(conn, targetDb) : undefined;
  }, [connections, targetConnId, targetDb]);

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
    tableSyncStrategiesKey,
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
  }, []);

  const handleSubmit = useCallback(async (): Promise<boolean> => {
    if (!canSubmit || submitting) return false;

    if (canSaveTask) {
      persistTask();
    }

    const sourceConn = connections.find((c) => c.id === sourceConnId);
    const targetConn = connections.find((c) => c.id === targetConnId);
    if (!sourceConn || !targetConn) return false;

    setSubmitting(true);
    setSubmitNotice(null);

    const tableNames = Array.from(sourceSelected).sort((a, b) => a.localeCompare(b));

    if (tab === "schemaSync") {
      const executableNames = tableNames.filter(
        (name) =>
          schemaCreateMissingTables ||
          !isSchemaSyncSourceTableMissingInTarget(
            name,
            targetSnapshot.tables,
            schemaCompareCaseSensitive,
          ),
      );
      if (executableNames.length === 0) {
        setSubmitNotice(t("database.toolbox.submitHintSchemaNoExecutable"));
        setSubmitting(false);
        return false;
      }
    }

    try {
      let bgTaskId: string;
      if (tab === "dataSync") {
        bgTaskId = await startDbDataSyncExecute(
          sourceConn,
          targetConn,
          sourceDb,
          targetDb,
          tableNames.map((name) => ({
            name,
            columns: sourceTableColumns[name] ?? [],
            strategy:
              tableSyncStrategies[name] ??
              (tableTargetStatus[name] === "new" ? "rewrite" : "rewrite"),
          })),
        );
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
      }
      recordSyncTaskRun(tableNames, bgTaskId);
      setSubmitNotice(t("database.toolbox.submitSuccess"));
      return true;
    } catch (error) {
      setSubmitNotice(String(error));
      return false;
    } finally {
      setSubmitting(false);
    }
  }, [
    canSubmit,
    submitting,
    connections,
    sourceConnId,
    targetConnId,
    sourceDb,
    targetDb,
    sourceSelected,
    tab,
    sourceTableColumns,
    sourceTableIndexes,
    tableSyncStrategies,
    tableTargetStatus,
    recordSyncTaskRun,
    canSaveTask,
    persistTask,
    t,
    schemaCreateMissingTables,
    schemaCompareCaseSensitive,
    resolvedSchemaTableNameCase,
    targetSnapshot.tables,
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
              loadingProgress={
                sourceSnapshot.loading
                  ? { total: loadTotal, current: loadCurrent, message: loadMessage }
                  : undefined
              }
              tab={tab}
              expandedTables={sourceExpanded}
              onToggleTable={toggleSourceTable}
              selectedTables={sourceSelected}
              onToggleSelect={toggleSourceSelected}
              onSelectAllTables={selectSourceAllTables}
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
              onSelectAllTables={() => {}}
              sourceSelectedTableNames={sourceSelectedTableNames}
              targetConfigured={targetConfigured}
              targetTablesLoading={tab === "schemaSync" ? targetSnapshot.loading : targetTablesLoading}
              tableTargetStatus={tableTargetStatus}
              tableSyncStrategies={tableSyncStrategies}
              onSyncStrategyChange={setTableSyncStrategy}
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
              onAnalyze={targetConfigured ? handleAnalyze : undefined}
              analyzeBusy={analyzeBusy}
              hasAnalysisResult={hasAnalysisResult}
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
            sourceConn={conflictDetailSourceConn}
            targetConn={conflictDetailTargetConn}
          />
        ) : null}
      </SubWindow>
    </div>
  );
}
