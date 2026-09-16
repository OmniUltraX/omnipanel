import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from "react";
import { useCallback, useEffect, useMemo } from "react";
import {
  applyIgnoredFieldsToAnalysisResult,
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
import {
  buildSchemaAlignedTableNames,
  filterAlignedTableNames,
  filterAlignedTableNamesByStatus,
  findTableByName,
  tableNameExistsInSet,
  resolveSchemaTableNameCase,
} from "./schemaSyncAlignedTables";
import {
  buildSyncAnalysisConfigKey,
  pickAnalysisCacheForRestore,
} from "./syncTaskAnalysisCache";
import {
  buildNewTableDiff,
  sourceTableSchemaSignature,
  type SchemaTableDiff,
} from "./schemaDiff";
import {
  connectionWithDatabase,
  resolveTableTargetStatusWithAnalysis,
  DEFAULT_DATA_SYNC_MODES,
  normalizeDataSyncModes,
  isSchemaTargetStatusFilterShowAll,
  type DataAnalysisResult,
  type DataSyncModes,
  type SyncSideSnapshot,
  type SyncTableInfo,
  type SyncTaskConfig,
  type TableTargetStatus,
  type ToolboxTabId,
  type SchemaTargetRowStatus,
} from "./types";
import {
  EMPTY_SNAPSHOT,
  EMPTY_SCHEMA_TABLE_DIFFS,
} from "./databaseToolboxConstants";

export type UseDatabaseToolboxConnectionsDeps = {
  active: boolean;
  addSourceTablesRunRef: MutableRefObject<any>;
  advanceLoadProgress: any;
  analysisAnalyzedAtRef: MutableRefObject<any>;
  analyzingRef: MutableRefObject<any>;
  cachedAnalysisLoadedKeyRef: MutableRefObject<any>;
  connections: DbConnectionConfig[];
  countingRef: MutableRefObject<any>;
  ignoredFields: string[];
  initialSourceConnectionId: string | null | undefined;
  initialSourceDatabase: string;
  lastAnalysisConfigKeyRef: MutableRefObject<any>;
  lastAnalyzedSelectionRef: MutableRefObject<any>;
  pendingAddedTablesRef: MutableRefObject<any>;
  postExecuteReanalysisTablesRef: MutableRefObject<any>;
  prevSourceConnIdRef: MutableRefObject<any>;
  prevSourceSideKeyRef: MutableRefObject<any>;
  prevTargetConnIdRef: MutableRefObject<any>;
  prevTargetSideKeyRef: MutableRefObject<any>;
  resetLoadProgress: any;
  schemaAnalysisDiffs: Record<string, SchemaTableDiff>;
  schemaAnalyzing: boolean;
  schemaCompareCaseSensitive: boolean;
  schemaFetchingRef: MutableRefObject<any>;
  schemaTableDiffs: Record<string, SchemaTableDiff>;
  schemaTableSearch: string;
  schemaTargetStatusFilters: SchemaTargetRowStatus[];
  scrollSyncLockRef: MutableRefObject<any>;
  setAnalysisAnalyzedAt: Dispatch<SetStateAction<number | null>>;
  setConflictDetailTable: Dispatch<SetStateAction<string | null>>;
  setCountingTables: Dispatch<SetStateAction<Set<string>>>;
  setSchemaAnalysisDiffs: Dispatch<SetStateAction<Record<string, SchemaTableDiff>>>;
  setSchemaTableDiffs: Dispatch<SetStateAction<Record<string, SchemaTableDiff>>>;
  setSchemaTableSearch: Dispatch<SetStateAction<string>>;
  setSourceAddingTables: Dispatch<SetStateAction<boolean>>;
  setSourceCatalogError: Dispatch<SetStateAction<string | null>>;
  setSourceCatalogLoading: Dispatch<SetStateAction<boolean>>;
  setSourceCatalogNames: Dispatch<SetStateAction<string[]>>;
  setSourceConnId: Dispatch<SetStateAction<string>>;
  setSourceDb: Dispatch<SetStateAction<string>>;
  setSourceDbs: Dispatch<SetStateAction<string[]>>;
  setSourceDbsLoading: Dispatch<SetStateAction<boolean>>;
  setSourceExpanded: Dispatch<SetStateAction<Set<string>>>;
  setSourceListHighlight: Dispatch<SetStateAction<Set<string>>>;
  setSourceSelected: Dispatch<SetStateAction<Set<string>>>;
  setSourceSnapshot: Dispatch<SetStateAction<SyncSideSnapshot>>;
  setSubmitNotice: Dispatch<SetStateAction<string | null>>;
  setSyncLockedTables: Dispatch<SetStateAction<Set<string>>>;
  setTableAnalysis: Dispatch<SetStateAction<Record<string, DataAnalysisResult>>>;
  setTableSyncModes: Dispatch<SetStateAction<Record<string, DataSyncModes>>>;
  setTableTargetStatus: Dispatch<SetStateAction<Record<string, TableTargetStatus>>>;
  setTargetConnId: Dispatch<SetStateAction<string>>;
  setTargetCountingTables: Dispatch<SetStateAction<Set<string>>>;
  setTargetDb: Dispatch<SetStateAction<string>>;
  setTargetDbs: Dispatch<SetStateAction<string[]>>;
  setTargetDbsLoading: Dispatch<SetStateAction<boolean>>;
  setTargetRowCounts: Dispatch<SetStateAction<Record<string, number | null>>>;
  setTargetSnapshot: Dispatch<SetStateAction<SyncSideSnapshot>>;
  setTargetTableNames: Dispatch<SetStateAction<Set<string>>>;
  setTargetTablesLoading: Dispatch<SetStateAction<boolean>>;
  sourceAddingTables: boolean;
  sourceCatalogLoading: boolean;
  sourceCatalogNamesRef: MutableRefObject<string[]>;
  sourceConnId: string;
  sourceDb: string;
  sourceDbs: string[];
  sourceListRef: RefObject<HTMLDivElement | null>;
  sourceSelected: Set<string>;
  sourceSideBusy: boolean;
  sourceSnapshot: SyncSideSnapshot;
  sourceSnapshotTablesRef: MutableRefObject<SyncSideSnapshot["tables"]>;
  syncRunIdRef: MutableRefObject<any>;
  syncTaskId: string;
  t: (key: string, params?: Record<string, string | number>) => string;
  tab: ToolboxTabId;
  tableAnalysis: Record<string, DataAnalysisResult>;
  tableAnalysisRef: MutableRefObject<Record<string, DataAnalysisResult>>;
  targetConfigured: boolean;
  targetConnId: string;
  targetCountingRef: MutableRefObject<any>;
  targetDb: string;
  targetDbs: string[];
  targetListRef: RefObject<HTMLDivElement | null>;
  targetRowCounts: Record<string, number | null>;
  targetSnapshot: SyncSideSnapshot;
  targetTableNames: Set<string>;
  targetTablesLoading: boolean;
  taskLoadRef: MutableRefObject<any>;
};

export function useDatabaseToolboxConnections(deps: UseDatabaseToolboxConnectionsDeps) {
  const {
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
    taskLoadRef
  } = deps;

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

const removeSourceTables = useCallback((tableNames: string[]) => {
  if (tableNames.length === 0) {
    return;
  }
  const removeSet = new Set(tableNames);
  setSourceSnapshot((prev) => ({
    ...prev,
    tables: prev.tables.filter((table) => !removeSet.has(table.name)),
  }));
  setSourceSelected((prev) => {
    let changed = false;
    const next = new Set(prev);
    for (const name of removeSet) {
      if (next.delete(name)) {
        changed = true;
      }
    }
    return changed ? next : prev;
  });
  setSourceListHighlight((prev) => {
    let changed = false;
    const next = new Set(prev);
    for (const name of removeSet) {
      if (next.delete(name)) {
        changed = true;
      }
    }
    return changed ? next : prev;
  });
  setTableAnalysis((prev) => {
    let changed = false;
    const next = { ...prev };
    for (const name of removeSet) {
      if (name in next) {
        delete next[name];
        changed = true;
      }
    }
    return changed ? next : prev;
  });
  setTableTargetStatus((prev) => {
    let changed = false;
    const next = { ...prev };
    for (const name of removeSet) {
      if (name in next) {
        delete next[name];
        changed = true;
      }
    }
    return changed ? next : prev;
  });
  setTableSyncModes((prev) => {
    let changed = false;
    const next = { ...prev };
    for (const name of removeSet) {
      if (name in next) {
        delete next[name];
        changed = true;
      }
    }
    return changed ? next : prev;
  });
  for (const name of removeSet) {
    lastAnalyzedSelectionRef.current.delete(name);
  }
}, []);

/** 数据同步：多选下拉同步源表列表（选中添加并分析，取消则移除） */
const syncSourceTableSelection = useCallback(
  (nextNames: string[]) => {
    const nextSet = new Set(nextNames);
    const currentNames = sourceSnapshotTablesRef.current.map((table) => table.name);
    const currentSet = new Set(currentNames);
    const toAdd = nextNames.filter((name) => !currentSet.has(name));
    const toRemove = currentNames.filter((name) => !nextSet.has(name));
    if (toRemove.length > 0) {
      removeSourceTables(toRemove);
    }
    if (toAdd.length > 0) {
      void addSourceTables(toAdd);
    }
  },
  [addSourceTables, removeSourceTables],
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


  return {
    restoreAnalysisFromConfig,
    clearAnalysisState,
    pickDefaultConnId,
    loadDatabases,
    loadTargetTableNames,
    loadTargetSnapshot,
    loadSourceCatalog,
    loadSourceSnapshot,
    addSourceTables,
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
    schemaAlignedTableNames,
    visibleSchemaAlignedTableNames
  };
}
