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
  matchSqlResultEditColumns,
  mergeSqlResultOverrides,
  resolveSqlResultEditTarget,
  sqlResultCellDirty,
  type SqlResultDirtyRows,
  type SqlResultEditColumns,
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
  const target = useMemo(() => resolveSqlResultEditTarget(session.sql), [session.sql]);
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
  const database =
    target?.schemaName || session.database || tabDatabase || connection?.database || "";

  const [tableColumns, setTableColumns] = useState<DbColumnMeta[] | null>(null);
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
  }, [session.id, session.executionId, session.result]);

  const connectionRef = useRef(connection);
  connectionRef.current = connection;

  useEffect(() => {
    const current = connectionRef.current;
    if (!target || !current || current.db_type === "redis" || !database) {
      setTableColumns(null);
      return;
    }
    const cached = getCachedTableColumns(
      useDbSchemaCacheStore.getState().snapshot,
      current.id,
      database,
      target.tableName,
    );
    if (cached?.length) {
      setTableColumns(cached);
    }
    let cancelled = false;
    void introspectTable({ ...current, database }, database, target.tableName)
      .then((schema) => {
        if (!cancelled) setTableColumns(schema.columns);
      })
      .catch(() => {
        if (!cancelled && !cached?.length) setTableColumns(null);
      });
    return () => {
      cancelled = true;
    };
  }, [connection?.db_type, connection?.id, database, schemaRevision, target]);

  const matched = useMemo<SqlResultEditColumns | null>(() => {
    if (!target || !tableColumns || !resultColumns?.length) return null;
    return matchSqlResultEditColumns(resultColumns, tableColumns);
  }, [resultColumns, tableColumns, target]);

  const editable = Boolean(matched) && !session.running;
  const columnMeta = matched?.columnMeta ?? [];

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
    target,
    editable,
    database,
    sessionId: session.id,
    resultPage: session.resultPage ?? 0,
  });
  commitStateRef.current = {
    matched,
    target,
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
      target: editTarget,
      editable: canEdit,
      database: dbName,
      sessionId,
      resultPage,
    } = commitStateRef.current;
    const current = connectionRef.current;
    if (!columns || !editTarget || !current || !canEdit) return;
    const changed = countSqlResultDirtyCells(snapshot);
    if (changed === 0) return;
    const statements = buildSqlResultUpdateStatements({
      dbType: current.db_type,
      schemaName: editTarget.schemaName,
      tableName: editTarget.tableName,
      dirty: snapshot,
      pkResultNames: columns.pkResultNames,
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
