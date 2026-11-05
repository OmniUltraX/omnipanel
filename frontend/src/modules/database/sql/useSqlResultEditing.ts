import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { commands } from "../../../ipc/bindings";
import { formatIpcError, unwrapCommand } from "../../../ipc/result";
import { useI18n } from "../../../i18n";
import { useDbSchemaCacheStore } from "../../../stores/dbSchemaCacheStore";
import { useDbWorkspaceTabStore } from "../../../stores/dbWorkspaceTabStore";
import { showToast } from "../../../stores/toastStore";
import { useDbWorkspace } from "../../../contexts/DbWorkspaceContext";
import { introspectTable, type DbColumnMeta, type DbConnectionConfig } from "../api";
import { getCachedTableColumns } from "../schema/schemaCacheMerge";
import { makeQueryRunId } from "./queryRun";
import { appendSqlExecution, makeSqlExecId, sqlExecDisplayName } from "./sqlExecLog";
import { resolveSqlPresenceToken } from "./sqlPresence";
import {
  buildSqlResultUpdateStatements,
  countSqlResultDirtyCells,
  matchSqlResultEditColumnsForTables,
  mergeSqlResultOverrides,
  parseSqlResultSelectOrigins,
  resolveSqlResultEditTargets,
  sqlResultCellDirty,
  type SqlResultDirtyRows,
  type SqlResultEditColumns,
  type SqlResultEditTarget,
} from "./sqlResultEdit";
import type { SqlResultSession } from "../workspace/dbWorkspaceState";

export type SqlResultEditBridge = {
  sessionId: string;
  editable: boolean;
  columnMeta: DbColumnMeta[];
  overrides: SqlResultDirtyRows;
  applyCell: (
    cell: { rowIndex: number; column: string; row: Record<string, unknown> },
    value: unknown,
  ) => void;
};

type UseSqlResultEditingOptions = {
  sqlTabId: string;
  session: SqlResultSession;
  /** 保存前先把侧栏里还没提交的输入写入脏数据 */
  beforeCommit?: () => void;
};

const EMPTY_COLUMN_META: DbColumnMeta[] = [];

function resolveEditDatabase(
  sessionDb: string,
  targets: SqlResultEditTarget[] | null,
  dbType: string | undefined,
): string {
  const schemaNames = [
    ...new Set(
      (targets ?? [])
        .map((target) => target.schemaName?.trim() || "")
        .filter(Boolean),
    ),
  ];
  const type = (dbType ?? "").toLowerCase();
  const mysqlLike = type.includes("mysql") || type.includes("mariadb");
  if (mysqlLike && schemaNames.length === 1) return schemaNames[0]!;
  return sessionDb;
}

export function useSqlResultEditing({
  sqlTabId,
  session,
  beforeCommit,
}: UseSqlResultEditingOptions) {
  const { t } = useI18n();
  const ws = useDbWorkspace();
  const schemaRevision = useDbSchemaCacheStore((state) => state.revision);
  const tabDatabase = useDbWorkspaceTabStore(
    (state) => state.sqlTabStates[sqlTabId]?.database ?? "",
  );
  const targets = useMemo(() => resolveSqlResultEditTargets(session.sql), [session.sql]);
  const selectOrigins = useMemo(() => parseSqlResultSelectOrigins(session.sql), [session.sql]);
  const connection = useMemo(() => {
    if (session.connId) {
      const bound = ws.resolveConnection(session.connId);
      if (bound) return bound;
    }
    return (
      ws.connectionForSqlTab(sqlTabId, session.sql) ??
      ws.resolveSqlTabConnection(sqlTabId)
    );
  }, [session.connId, session.sql, sqlTabId, ws]);
  // MySQL/MariaDB：唯一 schema.table 的 schema 就是库名；多 schema 或 PG 等沿用会话库。
  const database = resolveEditDatabase(
    session.database || tabDatabase || connection?.database || "",
    targets,
    connection?.db_type,
  );

  const [tableColumnsByKey, setTableColumnsByKey] = useState<Record<string, DbColumnMeta[]>>({});
  const [dirty, setDirty] = useState<SqlResultDirtyRows>({});
  const [committed, setCommitted] = useState<SqlResultDirtyRows>({});
  const [past, setPast] = useState<SqlResultDirtyRows[]>([]);
  const [future, setFuture] = useState<SqlResultDirtyRows[]>([]);
  const [committing, setCommitting] = useState(false);
  const dirtyRef = useRef(dirty);
  const committedRef = useRef(committed);
  dirtyRef.current = dirty;
  committedRef.current = committed;

  const resultColumns = session.result?.columns;

  useEffect(() => {
    dirtyRef.current = {};
    committedRef.current = {};
    setDirty({});
    setCommitted({});
    setPast([]);
    setFuture([]);
    // result 对象引用会抖动；只在会话/执行轮次变化时清空脏数据
  }, [session.id, session.executionId]);

  const connectionRef = useRef(connection);
  connectionRef.current = connection;

  useEffect(() => {
    const current = connectionRef.current;
    if (!targets?.length || !current || current.db_type === "redis" || !database) {
      setTableColumnsByKey({});
      return;
    }

    const cachedMap: Record<string, DbColumnMeta[]> = {};
    for (const target of targets) {
      const cacheDb =
        (current.db_type ?? "").toLowerCase().includes("mysql") ||
        (current.db_type ?? "").toLowerCase().includes("mariadb")
          ? target.schemaName?.trim() || database
          : database;
      const cached = getCachedTableColumns(
        useDbSchemaCacheStore.getState().snapshot,
        current.id,
        cacheDb,
        target.tableName,
      );
      if (cached?.length) {
        cachedMap[`${target.schemaName ?? ""}::${target.tableName}`] = cached;
      }
    }
    if (Object.keys(cachedMap).length > 0) {
      setTableColumnsByKey((prev) => ({ ...prev, ...cachedMap }));
    }

    let cancelled = false;
    void (async () => {
      const next: Record<string, DbColumnMeta[]> = { ...cachedMap };
      await Promise.all(
        targets.map(async (target) => {
          const key = `${target.schemaName ?? ""}::${target.tableName}`;
          const cacheDb =
            (current.db_type ?? "").toLowerCase().includes("mysql") ||
            (current.db_type ?? "").toLowerCase().includes("mariadb")
              ? target.schemaName?.trim() || database
              : database;
          try {
            const schema = await introspectTable(
              { ...current, database: cacheDb },
              cacheDb,
              target.tableName,
            );
            next[key] = schema.columns;
          } catch {
            if (!next[key] && cachedMap[key]) next[key] = cachedMap[key]!;
          }
        }),
      );
      if (!cancelled) setTableColumnsByKey(next);
    })();

    return () => {
      cancelled = true;
    };
  }, [connection?.db_type, connection?.id, database, schemaRevision, targets]);

  const matched = useMemo<SqlResultEditColumns | null>(() => {
    if (!targets?.length || !resultColumns?.length) return null;
    const tables = targets.map((target) => {
      const key = `${target.schemaName ?? ""}::${target.tableName}`;
      return { target, columns: tableColumnsByKey[key] ?? [] };
    });
    if (tables.some((table) => table.columns.length === 0)) return null;
    return matchSqlResultEditColumnsForTables(resultColumns, tables, selectOrigins);
  }, [resultColumns, selectOrigins, tableColumnsByKey, targets]);

  const editable = Boolean(matched) && !session.running;
  const columnMeta = matched?.columnMeta ?? EMPTY_COLUMN_META;

  const replaceDirty = useCallback((next: SqlResultDirtyRows, recordHistory: boolean) => {
    if (recordHistory) {
      setPast((prev) => [...prev, dirtyRef.current]);
      setFuture([]);
    }
    dirtyRef.current = next;
    setDirty(next);
  }, []);

  const applyCell = useCallback(
    (
      cell: { rowIndex: number; column: string; row: Record<string, unknown> },
      value: unknown,
    ) => {
      if (!matched) return;
      if (!matched.columnMeta.some((column) => column.name === cell.column)) return;
      const rowKey = matched.pkResultNames
        .map((name) => `${name}=${cell.row[name] == null ? "" : String(cell.row[name])}`)
        .join("&");
      const committedValue = committedRef.current[rowKey]?.[cell.column];
      const next = sqlResultCellDirty(
        dirtyRef.current,
        cell.row,
        matched.pkResultNames,
        cell.column,
        value,
        committedValue !== undefined ? committedValue : undefined,
      );
      if (JSON.stringify(next) === JSON.stringify(dirtyRef.current)) return;
      replaceDirty(next, true);
    },
    [matched, replaceDirty],
  );

  const undo = useCallback(() => {
    setPast((prev) => {
      if (prev.length === 0) return prev;
      const previous = prev[prev.length - 1] ?? {};
      setFuture((items) => [dirtyRef.current, ...items]);
      dirtyRef.current = previous;
      setDirty(previous);
      return prev.slice(0, -1);
    });
  }, []);

  const redo = useCallback(() => {
    setFuture((prev) => {
      if (prev.length === 0) return prev;
      const [next, ...rest] = prev;
      setPast((items) => [...items, dirtyRef.current]);
      dirtyRef.current = next ?? {};
      setDirty(next ?? {});
      return rest;
    });
  }, []);

  const undoAll = useCallback(() => {
    if (Object.keys(dirtyRef.current).length === 0) return;
    replaceDirty({}, true);
  }, [replaceDirty]);

  const commitStateRef = useRef({
    matched,
    editable,
    database,
    sessionId: session.id,
    resultPage: session.resultPage ?? 0,
  });
  commitStateRef.current = {
    matched,
    editable,
    database,
    sessionId: session.id,
    resultPage: session.resultPage ?? 0,
  };
  const wsRef = useRef(ws);
  wsRef.current = ws;

  const commit = useCallback(async () => {
    beforeCommit?.();
    const snapshot = dirtyRef.current;
    const {
      matched: columns,
      editable: canEdit,
      database: dbName,
      sessionId,
      resultPage,
    } = commitStateRef.current;
    const current = connectionRef.current;
    if (!columns || !current || !canEdit) return;
    const changed = countSqlResultDirtyCells(snapshot);
    if (changed === 0) return;
    const statements = buildSqlResultUpdateStatements({
      dbType: current.db_type,
      dirty: snapshot,
      targets: columns.targets,
      pkResultNamesByTarget: columns.pkResultNamesByTarget,
      resultToTargetIndex: columns.resultToTargetIndex,
      resultToTableName: columns.resultToTableName,
      columnTypeByResultName: columns.columnTypeByResultName,
    });
    if (statements.length === 0) return;

    const bound: DbConnectionConfig = { ...current, database: dbName };
    const tab = wsRef.current.tabs.find((item) => item.id === sqlTabId);
    const sqlFileId = tab?.kind === "sql" ? (tab.sqlFileId ?? null) : null;
    setCommitting(true);
    try {
      for (const sql of statements) {
        const token = await resolveSqlPresenceToken(bound, sql, t);
        if (token === null) return;
        const started = performance.now();
        try {
          const result = await unwrapCommand(
            commands.dbExecuteQuery(bound, sql, makeQueryRunId(), null, null, token ?? null),
          );
          await appendSqlExecution({
            id: makeSqlExecId(),
            executedAt: Date.now(),
            connectionId: bound.id,
            connectionName: bound.name,
            databaseName: bound.database,
            envTag: "",
            sqlFileId,
            tabId: sqlTabId,
            sql,
            displayName: sqlExecDisplayName(sql, "UPDATE"),
            status: "ok",
            elapsedMs: Math.round(performance.now() - started),
            rowsAffected: result.rowsAffected ?? 0,
            error: "",
            pinned: false,
            columns: [],
            rows: [],
          });
        } catch (error) {
          await appendSqlExecution({
            id: makeSqlExecId(),
            executedAt: Date.now(),
            connectionId: bound.id,
            connectionName: bound.name,
            databaseName: bound.database,
            envTag: "",
            sqlFileId,
            tabId: sqlTabId,
            sql,
            displayName: sqlExecDisplayName(sql, "UPDATE"),
            status: "error",
            elapsedMs: Math.round(performance.now() - started),
            rowsAffected: 0,
            error: formatIpcError(error),
            pinned: false,
            columns: [],
            rows: [],
          });
          throw error;
        }
      }
      committedRef.current = mergeSqlResultOverrides(committedRef.current, snapshot);
      setCommitted(committedRef.current);
      dirtyRef.current = {};
      setDirty({});
      setPast([]);
      setFuture([]);
      showToast(t("database.results.editSaved", { count: changed }));
      if (useDbWorkspaceTabStore.getState().sqlTabStates[sqlTabId]) {
        await wsRef.current.goToQueryResultPage(sqlTabId, resultPage, sessionId);
      }
    } catch (error) {
      showToast(t("database.results.editSaveFailed", { error: formatIpcError(error) }));
    } finally {
      setCommitting(false);
    }
  }, [beforeCommit, sqlTabId, t]);

  const overrides = useMemo(
    () => mergeSqlResultOverrides(committed, dirty),
    [committed, dirty],
  );
  const dirtyRowKeys = useMemo(() => new Set(Object.keys(dirty)), [dirty]);
  const dirtyCount = countSqlResultDirtyCells(dirty);

  const bridge = useMemo<SqlResultEditBridge>(
    () => ({
      sessionId: session.id,
      editable,
      columnMeta,
      overrides,
      applyCell,
    }),
    [applyCell, columnMeta, editable, overrides, session.id],
  );

  return {
    editable,
    columnMeta,
    overrides,
    dirtyRowKeys,
    dirtyCount,
    canUndo: past.length > 0,
    canRedo: future.length > 0,
    committing,
    applyCell,
    undo,
    redo,
    undoAll,
    commit,
    bridge,
  };
}
