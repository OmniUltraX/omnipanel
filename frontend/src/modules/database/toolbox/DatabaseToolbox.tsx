import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useI18n } from "../../../i18n";
import { Button } from "../../../components/ui/Button";
import { useDataLoading } from "../../../components/ui/DataLoading";
import { WarnAlert } from "../../../components/ui/WarnAlert";
import { SubWindow } from "../../../components/ui/SubWindow";
import { quickInput } from "../../../lib/quickInput";
import {
  cancelDbBackgroundTask,
  startDbDataSyncBackgroundTask,
  startDbDataSyncExecute,
  startDbSchemaSyncBackgroundTask,
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
  type SyncTaskConfig,
  type TableTargetStatus,
  type ToolboxTabId,
} from "./types";

const EMPTY_SNAPSHOT: SyncSideSnapshot = { tables: [], loading: false, error: null };

/** 逐条比对的行数门槛 */
const LARGE_TABLE_ROW_THRESHOLD = 10_000;

interface DatabaseToolboxProps {
  connections: DbConnectionConfig[];
  /** 数据同步 / 结构同步（由 DatabasePanel 顶级 Tab 传入） */
  tab: ToolboxTabId;
  /** 打开工具箱时默认元库连接 */
  initialSourceConnectionId?: string | null;
  initialSourceDatabase?: string;
  /** 为 false 时不发起任何库连接请求（分段 Tab 未激活时由父级传入） */
  active?: boolean;
}

export function DatabaseToolbox({
  connections,
  tab,
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

  const [targetTableNames, setTargetTableNames] = useState<Set<string>>(() => new Set());
  const [targetTablesLoading, setTargetTablesLoading] = useState(false);

  const [sourceExpanded, setSourceExpanded] = useState<Set<string>>(() => new Set());
  const [targetExpanded, setTargetExpanded] = useState<Set<string>>(() => new Set());
  const [showMatchingTables, setShowMatchingTables] = useState(true);
  const [sourceSelected, setSourceSelected] = useState<Set<string>>(() => new Set());
  const [tableTargetStatus, setTableTargetStatus] = useState<Record<string, TableTargetStatus>>({});
  const [tableSyncStrategies, setTableSyncStrategies] = useState<Record<string, DataSyncStrategy>>({});
  const [tableAnalysis, setTableAnalysis] = useState<Record<string, DataAnalysisResult>>({});
  const [conflictDetailTable, setConflictDetailTable] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitNotice, setSubmitNotice] = useState<string | null>(null);
  const [largeTableWarn, setLargeTableWarn] = useState<{ names: string[]; rows: Record<string, number> } | null>(null);
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
  const lastAnalyzedSelectionRef = useRef<Set<string>>(new Set());
  const bgDataTaskIdRef = useRef<string | null>(null);
  const bgSchemaTaskIdRef = useRef<string | null>(null);

  const pendingLoad = useDbSyncTaskStore((s) => s.pendingLoad);
  const syncTasks = useDbSyncTaskStore((s) => s.tasks);
  const clearPendingLoad = useDbSyncTaskStore((s) => s.clearPendingLoad);
  const setActiveTaskId = useDbSyncTaskStore((s) => s.setActiveTaskId);
  const addSyncTask = useDbSyncTaskStore((s) => s.addTask);

  /** 从侧栏加载任务时的分阶段配置 */
  const taskLoadRef = useRef<{ config: SyncTaskConfig; runAfterLoad: boolean } | null>(null);
  const runAfterLoadRef = useRef(false);
  const taskLoadAppliedRef = useRef(false);
  const prevSourceConnIdRef = useRef<string | null>(null);
  const prevTargetConnIdRef = useRef<string | null>(null);

  const targetConfigured = Boolean(targetConnId && targetDb.trim());

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

  useEffect(() => {
    if (!active) {
      return;
    }
    void loadTargetTableNames();
  }, [active, loadTargetTableNames]);

  useEffect(() => {
    if (!active) {
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

  useEffect(() => {
    syncRunIdRef.current += 1;
    countingRef.current.clear();
    setCountingTables(new Set());
    targetCountingRef.current.clear();
    setTargetCountingTables(new Set());
    schemaFetchingRef.current.clear();
    setSchemaTableDiffs({});
    setSourceSelected(new Set());
    setTableTargetStatus({});
    setTableSyncStrategies({});
    setTableAnalysis({});
    setConflictDetailTable(null);
    setSubmitNotice(null);
    analyzingRef.current.clear();
    lastAnalyzedSelectionRef.current = new Set();
    setTargetRowCounts({});
    void loadSideSnapshot(sourceConnId, sourceDb, tab);
  }, [active, sourceConnId, sourceDb, tab, loadSideSnapshot]);

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
        if (!targetTableNames.has(name)) {
          const sourceTable = sourceSnapshot.tables.find((t) => t.name === name);
          next[name] = buildNewTableDiff(
            name,
            sourceTable?.columns ?? [],
            sourceTable?.indexes ?? [],
          );
        } else {
          const sourceTable = sourceSnapshot.tables.find((t) => t.name === name);
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
  ]);

  const toggleSourceTable = useCallback((name: string) => {
    setSourceExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const toggleTargetTable = useCallback((name: string) => {
    setTargetExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

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

  const runBackgroundSchemaSync = useCallback(
    async (tableNames: string[]) => {
      if (tableNames.length === 0) return;

      const targetConn = connections.find((c) => c.id === targetConnId);
      if (!targetConn || !targetDb.trim()) return;

      await cancelDbBackgroundTask(bgSchemaTaskIdRef.current);
      bgSchemaTaskIdRef.current = null;

      for (const name of tableNames) {
        schemaFetchingRef.current.add(name);
        setSchemaTableDiffs((prev) => ({
          ...prev,
          [name]: { tableName: name, status: "checking", columns: [], indexes: [] },
        }));
      }

      try {
        const taskId = await startDbSchemaSyncBackgroundTask(
          targetConn,
          targetDb,
          tableNames,
          sourceTableColumns,
          sourceTableIndexes,
        );
        bgSchemaTaskIdRef.current = taskId;
      } catch (e) {
        for (const name of tableNames) {
          schemaFetchingRef.current.delete(name);
          setSchemaTableDiffs((prev) => ({
            ...prev,
            [name]: {
              tableName: name,
              status: "error",
              columns: [],
              indexes: [],
              error: typeof e === "string" ? e : String(e),
            },
          }));
        }
      }
    },
    [connections, targetConnId, targetDb, sourceTableColumns, sourceTableIndexes],
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
    setLargeTableWarn(null);

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
    return Object.values(schemaTableDiffs).some((diff) => diff.status === "checking");
  }, [tab, schemaTableDiffs]);

  const syncCompareBusy =
    (tab === "dataSync" && syncAnalysisBusy) || (tab === "schemaSync" && schemaSyncBusy);

  // 勾选即触发逐条比对：仅在 dataSync tab 下，对源侧新勾选且目标库中存在的表做处理。
  useEffect(() => {
    if (!active || tab !== "dataSync" || !targetConfigured || targetTablesLoading) return;
    const eligible = new Set(
      sourceSelectedTableNames.filter((name) => targetTableNames.has(name)),
    );
    const newlySelected: string[] = [];
    for (const name of eligible) {
      if (!lastAnalyzedSelectionRef.current.has(name)) {
        newlySelected.push(name);
      }
    }
    lastAnalyzedSelectionRef.current = eligible;
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
      setLargeTableWarn({ names: oversized, rows: oversizedRows });
      return;
    }
    void runBackgroundDataSync(newlySelected);
  }, [
    active,
    tab,
    targetConfigured,
    targetTablesLoading,
    sourceSelectedTableNames,
    targetTableNames,
    targetRowCounts,
    runBackgroundDataSync,
  ]);

  const confirmLargeTableAnalysis = useCallback(() => {
    const ctx = largeTableWarn;
    setLargeTableWarn(null);
    if (!ctx) return;
    void runBackgroundDataSync(ctx.names);
  }, [largeTableWarn, runBackgroundDataSync]);

  /** 结构同步：提交后台对比任务 */
  useEffect(() => {
    if (!active || tab !== "schemaSync" || !targetConfigured || targetTablesLoading) return;

    const selected = Array.from(sourceSelected).filter((name) => targetTableNames.has(name));
    const targetKey = schemaTargetKey;
    const toFetch: string[] = [];

    for (const name of selected) {
      if (schemaFetchingRef.current.has(name)) continue;
      const sourceTable = sourceSnapshot.tables.find((t) => t.name === name);
      const sourceKey = sourceTable
        ? sourceTableSchemaSignature(sourceTable.columns, sourceTable.indexes)
        : "";
      const prev = schemaTableDiffsRef.current[name];
      if (
        prev?.targetKey === targetKey &&
        prev?.sourceKey === sourceKey &&
        (prev.status === "diff" || prev.status === "match")
      ) {
        continue;
      }
      toFetch.push(name);
    }

    if (toFetch.length === 0) return;
    void runBackgroundSchemaSync(toFetch);
  }, [
    active,
    tab,
    targetConfigured,
    targetTablesLoading,
    sourceSelected,
    sourceSnapshot.tables,
    targetTableNames,
    schemaTargetKey,
    runBackgroundSchemaSync,
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
    syncRunIdRef.current += 1;
    taskLoadAppliedRef.current = false;
    runAfterLoadRef.current = false;
    setSubmitNotice(null);
    setTableTargetStatus({});
    setTableAnalysis({});
    setSchemaTableDiffs({});
    setConflictDetailTable(null);
    setLargeTableWarn(null);
    lastAnalyzedSelectionRef.current = new Set();
    analyzingRef.current.clear();
    countingRef.current.clear();
    targetCountingRef.current.clear();
    schemaFetchingRef.current.clear();
    setCountingTables(new Set());
    setTargetCountingTables(new Set());
    setTargetRowCounts({});
    setSourceSelected(new Set());
    setSourceExpanded(new Set());
    setTableSyncStrategies({});
    taskLoadRef.current = { config, runAfterLoad };
    prevSourceConnIdRef.current = null;
    prevTargetConnIdRef.current = null;
    setSourceConnId(config.sourceConnId);
    setTargetConnId(config.targetConnId);
    setSourceDb("");
    setTargetDb("");
  }, []);

  useEffect(() => {
    if (!active || !pendingLoad) {
      return;
    }
    const task = syncTasks.find((item) => item.id === pendingLoad.taskId);
    if (!task || task.kind !== tab) {
      return;
    }
    clearPendingLoad();
    setActiveTaskId(task.id);
    beginTaskLoad(task.config, pendingLoad.runAfterLoad);
  }, [active, pendingLoad, syncTasks, tab, clearPendingLoad, setActiveTaskId, beginTaskLoad]);

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
      }
      return;
    }

    taskLoadAppliedRef.current = true;
    setSourceSelected(new Set(config.selectedTables));
    setSourceExpanded(new Set(config.expandedTables ?? config.selectedTables));
    setTableSyncStrategies({ ...(config.tableSyncStrategies ?? {}) });
    const runAfter = load.runAfterLoad;
    taskLoadRef.current = null;
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
  ]);

  const buildTaskConfig = useCallback((): SyncTaskConfig => {
    return {
      sourceConnId,
      sourceDb,
      targetConnId,
      targetDb,
      selectedTables: Array.from(sourceSelected),
      expandedTables: Array.from(sourceExpanded),
      tableSyncStrategies: { ...tableSyncStrategies },
    };
  }, [
    sourceConnId,
    sourceDb,
    targetConnId,
    targetDb,
    sourceSelected,
    sourceExpanded,
    tableSyncStrategies,
  ]);

  const canSaveTask = useMemo(() => {
    return Boolean(sourceConnId && sourceDb.trim() && targetConnId && targetDb.trim());
  }, [sourceConnId, sourceDb, targetConnId, targetDb]);

  const handleSaveTask = useCallback(async () => {
    if (!canSaveTask) {
      return;
    }
    const sourceConn = connections.find((c) => c.id === sourceConnId);
    const targetConn = connections.find((c) => c.id === targetConnId);
    const defaultName =
      sourceConn && targetConn
        ? `${sourceConn.name}/${sourceDb} → ${targetConn.name}/${targetDb}`
        : t("database.syncTasks.defaultName");
    const name = await quickInput({
      title: t("database.syncTasks.saveTitle"),
      placeholder: t("database.syncTasks.namePlaceholder"),
      defaultValue: defaultName,
      validate: (value) => (value.trim() ? null : t("database.syncTasks.nameRequired")),
    });
    if (!name) {
      return;
    }
    addSyncTask({
      name: name.trim(),
      kind: tab,
      config: buildTaskConfig(),
    });
    setSubmitNotice(t("database.syncTasks.saveSuccess"));
  }, [canSaveTask, connections, sourceConnId, sourceDb, targetConnId, targetDb, tab, buildTaskConfig, addSyncTask, t]);

  const handleSubmit = useCallback(async () => {
    if (!canSubmit || submitting) return;

    const sourceConn = connections.find((c) => c.id === sourceConnId);
    const targetConn = connections.find((c) => c.id === targetConnId);
    if (!sourceConn || !targetConn) return;

    setSubmitting(true);
    setSubmitNotice(null);

    const tableNames = Array.from(sourceSelected).sort((a, b) => a.localeCompare(b));

    try {
      if (tab === "dataSync") {
        await startDbDataSyncExecute(
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
        await startDbSchemaSyncExecute(
          sourceConn,
          targetConn,
          sourceDb,
          targetDb,
          tableNames,
          sourceTableColumns,
          sourceTableIndexes,
        );
      }
      setSubmitNotice(t("database.toolbox.submitSuccess"));
    } catch (error) {
      setSubmitNotice(String(error));
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
              snapshot={EMPTY_SNAPSHOT}
              tab={tab}
              expandedTables={targetExpanded}
              onToggleTable={toggleTargetTable}
              selectedTables={new Set()}
              onToggleSelect={() => {}}
              onSelectAllTables={() => {}}
              sourceSelectedTableNames={sourceSelectedTableNames}
              targetConfigured={targetConfigured}
              targetTablesLoading={targetTablesLoading}
              tableTargetStatus={tableTargetStatus}
              tableSyncStrategies={tableSyncStrategies}
              onSyncStrategyChange={setTableSyncStrategy}
              schemaTableDiffs={schemaTableDiffs}
              tableAnalysis={tableAnalysis}
              conflictDetailTable={conflictDetailTable}
              onViewConflictDetail={handleViewConflictDetail}
              showMatchingTables={showMatchingTables}
              onShowMatchingTablesChange={setShowMatchingTables}
              sourceTableColumns={sourceTableColumns}
              sourceTableIndexes={sourceTableIndexes}
            />
          }
        />
      </div>

      <footer className="db-toolbox-footer">
        <div className="db-toolbox-footer__meta">
          {submitNotice ? (
            <span className="db-toolbox-footer__notice">{submitNotice}</span>
          ) : submitDisabledReason && !canSubmit ? (
            <span className="db-toolbox-footer__hint">{submitDisabledReason}</span>
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
            variant="outline"
            disabled={!canSaveTask}
            onClick={() => void handleSaveTask()}
          >
            {t("database.syncTasks.save")}
          </Button>
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
          />
        ) : null}
      </SubWindow>

      <WarnAlert
        open={largeTableWarn !== null}
        title={t("database.toolbox.side.analysisLargeTitle")}
        confirmLabel={t("database.toolbox.side.analysisLargeConfirm")}
        cancelLabel={t("shell.topbar.cancel", { defaultValue: "取消" })}
        onConfirm={confirmLargeTableAnalysis}
        onClose={() => setLargeTableWarn(null)}
      >
        {largeTableWarn && (
          <ul className="warn-alert-list">
            {largeTableWarn.names.map((name) => (
              <li key={name}>
                {t("database.toolbox.side.analysisLargeItem", {
                  name,
                  rows: largeTableWarn.rows[name]?.toLocaleString() ?? "—",
                })}
              </li>
            ))}
          </ul>
        )}
      </WarnAlert>
    </div>
  );
}
