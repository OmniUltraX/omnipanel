import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../../i18n";
import { useDataLoading } from "../../../components/ui/DataLoading";
import { WarnAlert } from "../../../components/ui/WarnAlert";
import {
  countTable,
  countTables,
  introspectSchema,
  introspectTable,
  listDatabases,
  listTables,
  type DbConnectionConfig,
} from "../api";
import { SyncSidePanel } from "./SyncSidePanel";
import {
  buildNewTableDiff,
  compareTableColumns,
  type SchemaTableDiff,
  sourceColumnsSignature,
} from "./schemaDiff";
import {
  connectionWithDatabase,
  resolveDataSyncConflictStatus,
  type DataAnalysisResult,
  type DataSyncStrategy,
  type SyncSideSnapshot,
  type SyncTableInfo,
  type TableTargetStatus,
  type ToolboxTabId,
} from "./types";

const EMPTY_SNAPSHOT: SyncSideSnapshot = { tables: [], loading: false, error: null };

/** 逐条比对的行数门槛 */
const LARGE_TABLE_ROW_THRESHOLD = 10_000;

interface DatabaseToolboxProps {
  connections: DbConnectionConfig[];
  /** 打开工具箱时默认元库连接 */
  initialSourceConnectionId?: string | null;
  initialSourceDatabase?: string;
}

export function DatabaseToolbox({
  connections,
  initialSourceConnectionId,
  initialSourceDatabase = "",
}: DatabaseToolboxProps) {
  const { t } = useI18n();
  const {
    total: loadTotal,
    current: loadCurrent,
    message: loadMessage,
    reset: resetLoadProgress,
    advance: advanceLoadProgress,
  } = useDataLoading();
  const [tab, setTab] = useState<ToolboxTabId>("dataSync");

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
  const [sourceSelected, setSourceSelected] = useState<Set<string>>(() => new Set());
  const [tableTargetStatus, setTableTargetStatus] = useState<Record<string, TableTargetStatus>>({});
  const [tableSyncStrategies, setTableSyncStrategies] = useState<Record<string, DataSyncStrategy>>({});
  const [tableAnalysis, setTableAnalysis] = useState<Record<string, DataAnalysisResult>>({});
  const [largeTableWarn, setLargeTableWarn] = useState<{ names: string[]; rows: Record<string, number> } | null>(null);
  const analyzingRef = useRef(new Set<string>());

  const countingRef = useRef(new Set<string>());
  const [countingTables, setCountingTables] = useState<Set<string>>(() => new Set());
  const targetCountingRef = useRef(new Set<string>());
  const [targetRowCounts, setTargetRowCounts] = useState<Record<string, number | null>>({});

  const schemaFetchingRef = useRef(new Set<string>());
  const [schemaTableDiffs, setSchemaTableDiffs] = useState<Record<string, SchemaTableDiff>>({});
  const schemaTableDiffsRef = useRef(schemaTableDiffs);
  schemaTableDiffsRef.current = schemaTableDiffs;

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
    const defaultConn = pickDefaultConnId(initialSourceConnectionId);
    setSourceConnId(defaultConn);
    setTargetConnId(defaultConn);
  }, [initialSourceConnectionId, pickDefaultConnId, connections]);

  useEffect(() => {
    const db = initialSourceDatabase.trim();
    if (!db || sourceDbs.length === 0) {
      return;
    }
    if (sourceDbs.includes(db)) {
      setSourceDb(db);
    }
  }, [initialSourceDatabase, sourceDbs]);

  useEffect(() => {
    const db = initialSourceDatabase.trim();
    if (!db || targetDbs.length === 0) {
      return;
    }
    if (targetDbs.includes(db)) {
      setTargetDb(db);
    }
  }, [initialSourceDatabase, targetDbs]);

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
        setDb((current) => (current && names.includes(current) ? current : names[0] ?? ""));
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
    if (!sourceConnId) {
      setSourceDbs([]);
      return;
    }
    void loadDatabases(sourceConnId, "source");
  }, [sourceConnId, loadDatabases]);

  useEffect(() => {
    if (!targetConnId) {
      setTargetDbs([]);
      return;
    }
    void loadDatabases(targetConnId, "target");
  }, [targetConnId, loadDatabases]);

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
    void loadTargetTableNames();
  }, [loadTargetTableNames]);

  useEffect(() => {
    targetCountingRef.current.clear();
    setTargetRowCounts({});
  }, [targetConnId, targetDb]);

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
    countingRef.current.clear();
    setCountingTables(new Set());
    schemaFetchingRef.current.clear();
    setSchemaTableDiffs({});
    setSourceSelected(new Set());
    setTableTargetStatus({});
    setTableSyncStrategies({});
    setTargetRowCounts({});
    targetCountingRef.current.clear();
    void loadSideSnapshot(sourceConnId, sourceDb, tab);
  }, [sourceConnId, sourceDb, tab, loadSideSnapshot]);

  /** 数据同步：勾选源表后统计行数 */
  useEffect(() => {
    if (tab !== "dataSync" || sourceSnapshot.loading) return;

    const conn = connections.find((c) => c.id === sourceConnId);
    if (!conn || !sourceDb.trim()) return;

    const pending = Array.from(sourceSelected).filter((name) => {
      if (countingRef.current.has(name)) return false;
      const tbl = sourceSnapshot.tables.find((t) => t.name === name);
      return tbl && tbl.rowCount === null;
    });

    if (pending.length === 0) return;

    const scoped = connectionWithDatabase(conn, sourceDb);
    let cancelled = false;

    for (const name of pending) {
      countingRef.current.add(name);
    }
    setCountingTables((prev) => new Set([...prev, ...pending]));

    void (async () => {
      for (const name of pending) {
        if (cancelled) break;
        try {
          const count = await countTable(scoped, name, sourceDb);
          if (cancelled) return;
          setSourceSnapshot((prev) => ({
            ...prev,
            tables: prev.tables.map((t) =>
              t.name === name ? { ...t, rowCount: count } : t,
            ),
          }));
        } catch {
          if (cancelled) return;
          setSourceSnapshot((prev) => ({
            ...prev,
            tables: prev.tables.map((t) =>
              t.name === name ? { ...t, rowCount: -1 } : t,
            ),
          }));
        } finally {
          countingRef.current.delete(name);
          if (!cancelled) {
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
      cancelled = true;
      for (const name of pending) {
        countingRef.current.delete(name);
      }
      setCountingTables((prev) => {
        const next = new Set(prev);
        for (const name of pending) next.delete(name);
        return next;
      });
    };
  }, [tab, sourceSnapshot.loading, sourceSnapshot.tables, sourceSelected, sourceConnId, sourceDb, connections]);

  /** 数据同步：已勾选且目标存在的表，统计目标侧行数 */
  useEffect(() => {
    if (tab !== "dataSync" || !targetConfigured || targetTablesLoading) return;

    const conn = connections.find((c) => c.id === targetConnId);
    if (!conn || !targetDb.trim()) return;

    const pending = Array.from(sourceSelected).filter(
      (name) =>
        targetTableNames.has(name) &&
        !targetCountingRef.current.has(name) &&
        !(name in targetRowCounts),
    );

    if (pending.length === 0) return;

    const scoped = connectionWithDatabase(conn, targetDb);
    let cancelled = false;

    for (const name of pending) {
      targetCountingRef.current.add(name);
    }

    void (async () => {
      try {
        const results = await countTables(scoped, targetDb, pending);
        if (cancelled) return;
        setTargetRowCounts((prev) => {
          const next = { ...prev };
          for (const row of results) {
            next[row.name] = row.count ?? -1;
          }
          for (const name of pending) {
            if (!(name in next)) {
              next[name] = -1;
            }
          }
          return next;
        });
      } catch {
        if (cancelled) return;
        setTargetRowCounts((prev) => {
          const next = { ...prev };
          for (const name of pending) {
            next[name] = -1;
          }
          return next;
        });
      } finally {
        for (const name of pending) {
          targetCountingRef.current.delete(name);
        }
      }
    })();

    return () => {
      cancelled = true;
      for (const name of pending) {
        targetCountingRef.current.delete(name);
      }
    };
  }, [
    tab,
    targetConfigured,
    targetTablesLoading,
    sourceSelected,
    targetTableNames,
    targetConnId,
    targetDb,
    connections,
  ]);

  /** 已勾选源表：按源/目标行数判定冲突或新增 */
  useEffect(() => {
    if (!targetConfigured || tab !== "dataSync") {
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
    if (!targetConfigured || tab !== "schemaSync") {
      setSchemaTableDiffs({});
      return;
    }

    const selected = Array.from(sourceSelected);

    if (targetTablesLoading) {
      setSchemaTableDiffs(() => {
        const next: Record<string, SchemaTableDiff> = {};
        for (const name of selected) {
          next[name] = { tableName: name, status: "checking", columns: [] };
        }
        return next;
      });
      return;
    }

    const targetKey = `${targetConnId}|${targetDb}`;

    const toFetch: string[] = [];
    for (const name of selected) {
      if (!targetTableNames.has(name)) continue;
      if (schemaFetchingRef.current.has(name)) continue;

      const sourceTable = sourceSnapshot.tables.find((t) => t.name === name);
      const sourceKey = sourceTable ? sourceColumnsSignature(sourceTable.columns) : "";
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

    setSchemaTableDiffs((prev) => {
      const next: Record<string, SchemaTableDiff> = {};
      for (const name of selected) {
        if (!targetTableNames.has(name)) {
          const sourceTable = sourceSnapshot.tables.find((t) => t.name === name);
          next[name] = buildNewTableDiff(name, sourceTable?.columns ?? []);
        } else {
          const sourceTable = sourceSnapshot.tables.find((t) => t.name === name);
          const sourceKey = sourceTable ? sourceColumnsSignature(sourceTable.columns) : "";
          if (
            prev[name]?.targetKey === targetKey &&
            prev[name]?.sourceKey === sourceKey &&
            (prev[name].status === "diff" || prev[name].status === "match")
          ) {
            next[name] = prev[name];
          } else {
            next[name] = { tableName: name, status: "checking", columns: [] };
          }
        }
      }
      return next;
    });

    const conn = connections.find((c) => c.id === targetConnId);
    if (!conn || !targetDb.trim() || toFetch.length === 0) return;

    const scoped = connectionWithDatabase(conn, targetDb);
    let cancelled = false;

    for (const name of toFetch) {
      schemaFetchingRef.current.add(name);
    }

    void (async () => {
      for (const name of toFetch) {
        if (cancelled) break;
        const sourceTable = sourceSnapshot.tables.find((t) => t.name === name);
        if (!sourceTable) {
          schemaFetchingRef.current.delete(name);
          continue;
        }

        try {
          const targetTable = await introspectTable(scoped, targetDb, name);
          if (cancelled) return;

          const columns = compareTableColumns(sourceTable.columns, targetTable.columns);
          const sourceKey = sourceColumnsSignature(sourceTable.columns);
          setSchemaTableDiffs((prev) => ({
            ...prev,
            [name]: {
              tableName: name,
              status: columns.length === 0 ? "match" : "diff",
              columns,
              targetKey,
              sourceKey,
            },
          }));
        } catch (e) {
          if (cancelled) return;
          setSchemaTableDiffs((prev) => ({
            ...prev,
            [name]: {
              tableName: name,
              status: "error",
              columns: [],
              error: typeof e === "string" ? e : String(e),
            },
          }));
        } finally {
          schemaFetchingRef.current.delete(name);
        }
      }
    })();

    return () => {
      cancelled = true;
      for (const name of toFetch) {
        schemaFetchingRef.current.delete(name);
      }
    };
  }, [
    tab,
    sourceSelected,
    sourceSnapshot.tables,
    targetTableNames,
    targetTablesLoading,
    targetConfigured,
    targetConnId,
    targetDb,
    connections,
  ]);

  const toggleSourceTable = useCallback((name: string) => {
    setSourceExpanded((prev) => {
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

  const runRowByRowAnalysis = useCallback(
    async (tableNames: string[]) => {
      if (tableNames.length === 0) return;
      const target = connectionWithDatabase(
        connections.find((c) => c.id === targetConnId) ?? connections[0]!,
        targetDb,
      );

      for (const name of tableNames) {
        if (analyzingRef.current.has(name)) continue;
        analyzingRef.current.add(name);
        setTableAnalysis((prev) => ({
          ...prev,
          [name]: { status: "analyzing" },
        }));
        try {
          // 占位骨架：等待 500ms 后置为 match，等真实逐行比对命令接入。
          await new Promise((resolve) => setTimeout(resolve, 500));
          if (!analyzingRef.current.has(name)) return;
          setTableAnalysis((prev) => ({
            ...prev,
            [name]: { status: "match" },
          }));
        } catch (e) {
          setTableAnalysis((prev) => ({
            ...prev,
            [name]: { status: "error", error: typeof e === "string" ? e : String(e) },
          }));
        } finally {
          analyzingRef.current.delete(name);
        }
        void target;
      }
    },
    [connections, targetConnId, targetDb],
  );

  // 勾选即触发逐条比对：仅在 dataSync tab 下，对源侧新勾选且目标库中存在的表做处理。
  const lastAnalyzedSelectionRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (tab !== "dataSync" || !targetConfigured || targetTablesLoading) return;
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
    void runRowByRowAnalysis(newlySelected);
  }, [
    tab,
    targetConfigured,
    targetTablesLoading,
    sourceSelectedTableNames,
    targetTableNames,
    targetRowCounts,
    runRowByRowAnalysis,
  ]);

  const confirmLargeTableAnalysis = useCallback(() => {
    const ctx = largeTableWarn;
    setLargeTableWarn(null);
    if (!ctx) return;
    void runRowByRowAnalysis(ctx.names);
  }, [largeTableWarn, runRowByRowAnalysis]);

  const tabs = useMemo(
    () =>
      [
        { id: "dataSync" as const, label: t("database.toolbox.tabs.dataSync") },
        { id: "schemaSync" as const, label: t("database.toolbox.tabs.schemaSync") },
      ] satisfies { id: ToolboxTabId; label: string }[],
    [t],
  );

  return (
    <div className="db-toolbox">
      <nav className="db-toolbox-tabs" role="tablist">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={`db-toolbox-tab${tab === item.id ? " active" : ""}`}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <div className="db-toolbox-panels" role="tabpanel">
        <div className="db-toolbox-split">
          <SyncSidePanel
            sideLabel={t("database.toolbox.side.source")}
            connections={connections}
            connectionId={sourceConnId}
            database={sourceDb}
            onConnectionChange={setSourceConnId}
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
          <div className="db-toolbox-split__divider" aria-hidden />
          <SyncSidePanel
            sideLabel={t("database.toolbox.side.target")}
            tableListMode="targetSync"
            connections={connections}
            connectionId={targetConnId}
            database={targetDb}
            onConnectionChange={setTargetConnId}
            onDatabaseChange={setTargetDb}
            databases={targetDbs}
            databasesLoading={targetDbsLoading}
            snapshot={EMPTY_SNAPSHOT}
            tab={tab}
            expandedTables={new Set()}
            onToggleTable={() => {}}
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
          />
        </div>
      </div>
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
