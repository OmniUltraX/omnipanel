import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { ContextMenu, type ContextMenuItem } from "../../../components/ui/menu/ContextMenu";
import { contextMenuIcons } from "../../../components/ui/menu/contextMenuIcons";
import { WorkbenchActionButton } from "../../../components/ui/primitives/WorkbenchActionButton";
import { useI18n } from "../../../i18n";
import type { SqlResultSession } from "../workspace/dbWorkspaceState";
import type { TableDataGridActiveCell, TableDataGridActions } from "../grid/TableDataGrid";
import { SqlResultSessionPanel } from "./SqlResultSessionPanel";
import type { MutableRefObject } from "react";
import {
  deleteSqlExecution,
  formatSqlExecRelativeTime,
  getSqlExecResult,
  importLegacySqlQueryHistory,
  listSqlExecutions,
  setSqlExecPinned,
  subscribeSqlExecLog,
  type SqlExecRecord,
} from "./sqlExecLog";
import { openSqlInNewQuery } from "../schema/tableObjectActions";

export interface SqlResultSessionsDockProps {
  sqlTabId: string;
  sqlFileId?: string;
  connectionId?: string;
  sessions: SqlResultSession[];
  activeSessionId: string | null;
  onActiveSessionChange: (sessionId: string) => void;
  onCloseSession: (sessionId: string) => void;
  onPinSession: (sessionId: string, pinned: boolean) => void;
  onInsertSql?: (sql: string) => void;
  detailCollapsed?: boolean;
  gridActionsRef?: MutableRefObject<TableDataGridActions | null>;
  onActiveCellChange?: (cell: TableDataGridActiveCell | null) => void;
  onSelectedCellsChange?: (cells: TableDataGridActiveCell[]) => void;
  onCellEditorFocusRequest?: () => void;
  onRowBandSelect?: () => void;
}

function statementKey(sql: string): string {
  return sql.trim().replace(/\s+/g, " ").toLowerCase();
}

function liveRecord(session: SqlResultSession, seenAt: number): SqlExecRecord {
  return {
    id: session.id,
    executedAt: seenAt,
    connectionId: "",
    connectionName: "",
    databaseName: "",
    envTag: "",
    sqlFileId: null,
    tabId: "",
    sql: session.sql,
    displayName: session.sql.replace(/\s+/g, " ").trim().slice(0, 80) || "SQL",
    status: session.running ? "ok" : session.error ? "error" : "ok",
    elapsedMs: session.elapsed,
    rowsAffected: session.result?.rowsAffected ?? 0,
    rowCount: session.result?.rows.length ?? 0,
    error: session.error ?? "",
    pinned: Boolean(session.pinned),
    resultTruncated: false,
    hasResult: Boolean(session.result),
  };
}

export const SqlResultSessionsDock = memo(function SqlResultSessionsDock({
  sqlTabId,
  sqlFileId,
  connectionId,
  sessions,
  activeSessionId,
  onActiveSessionChange,
  onCloseSession,
  onPinSession,
  onInsertSql,
  detailCollapsed = true,
  gridActionsRef,
  onActiveCellChange,
  onSelectedCellsChange,
  onCellEditorFocusRequest,
  onRowBandSelect,
}: SqlResultSessionsDockProps) {
  const { t } = useI18n();
  const [records, setRecords] = useState<SqlExecRecord[]>([]);
  const [kind, setKind] = useState("");
  const [tableName, setTableName] = useState("");
  const [groupBySql, setGroupBySql] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [storedView, setStoredView] = useState<SqlResultSession | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(activeSessionId);
  const [seenAt] = useState(() => new Map<string, number>());
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const followedActiveIdRef = useRef<string | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const reload = useCallback(async () => {
    await importLegacySqlQueryHistory();
    const rows = await listSqlExecutions({
      sqlFileId: sqlFileId ?? null,
      tabId: sqlTabId,
      kind: kind || null,
      tableName: tableName.trim() || null,
      limit: 200,
    });
    setRecords(rows);
  }, [kind, sqlFileId, sqlTabId, tableName]);

  useEffect(() => {
    void reload();
    return subscribeSqlExecLog(() => {
      void reload();
    });
  }, [reload]);

  const items = useMemo(() => {
    const byId = new Map(records.map((row) => [row.id, row]));
    for (const session of sessions) {
      if (session.executionId && byId.has(session.executionId)) continue;
      if (!session.running) continue;
      if (!seenAt.has(session.id)) seenAt.set(session.id, Date.now());
      byId.set(session.id, liveRecord(session, seenAt.get(session.id) ?? Date.now()));
    }
    return [...byId.values()].sort((a, b) => b.executedAt - a.executedAt || b.id.localeCompare(a.id));
  }, [records, seenAt, sessions]);

  const groups = useMemo(() => {
    if (!groupBySql) return [];
    const map = new Map<string, SqlExecRecord[]>();
    for (const item of items) {
      const key = statementKey(item.sql);
      const list = map.get(key);
      if (list) list.push(item);
      else map.set(key, [item]);
    }
    return [...map.entries()];
  }, [groupBySql, items]);

  const selected = items.find((item) => item.id === selectedId) ?? items[0];
  const liveSession = sessions.find(
    (item) => item.executionId === selected?.id || (item.running && item.id === selected?.id),
  );
  const viewSession = liveSession ?? (storedView?.id === selected?.id ? storedView : null);

  const openRecord = useCallback(
    async (record: SqlExecRecord) => {
      setSelectedId(record.id);
      const live = sessions.find(
        (item) => item.executionId === record.id || (item.running && item.id === record.id),
      );
      if (live) {
        if (live.running) onActiveSessionChange(live.id);
        setStoredView(null);
        return;
      }
      if (!record.hasResult || record.status !== "ok") {
        setStoredView({
          id: record.id,
          sql: record.sql,
          result: null,
          error:
            record.status === "cancelled"
              ? t("database.queryCancelled")
              : record.error || t("database.sqlExec.noResult"),
          elapsed: record.elapsedMs,
          running: false,
          resultPage: 0,
          resultHasMore: false,
          pinned: record.pinned,
        });
        return;
      }
      const page = await getSqlExecResult(record.id);
      setStoredView({
        id: record.id,
        sql: record.sql,
        result: page
          ? { columns: page.columns, rows: page.rows, rowsAffected: page.rowsAffected }
          : null,
        error: page ? null : t("database.sqlExec.noResult"),
        elapsed: record.elapsedMs,
        running: false,
        resultPage: 0,
        resultHasMore: false,
        pinned: record.pinned,
      });
    },
    [onActiveSessionChange, sessions, t],
  );

  useEffect(() => {
    const active = sessions.find((item) => item.id === activeSessionId);
    const followId = active?.executionId ?? (active?.running ? active.id : null);
    if (!followId || followId === followedActiveIdRef.current) return;
    const match = items.find((item) => item.id === followId);
    if (!match) return;
    followedActiveIdRef.current = followId;
    void openRecord(match);
  }, [activeSessionId, items, openRecord, sessions]);

  const contextMenuItems = useMemo<ContextMenuItem[]>(() => {
    const record = items.find((item) => item.id === contextMenu?.id);
    if (!record) return [];
    return [
      {
        id: "insert",
        label: t("database.sqlExec.fillBack"),
        onClick: () => onInsertSql?.(record.sql),
      },
      {
        id: "open-new",
        label: t("database.sqlExec.openNew"),
        onClick: () => openSqlInNewQuery(connectionId ?? record.connectionId, record.databaseName, record.sql),
      },
      {
        id: "pin",
        label: record.pinned ? t("database.results.unpinSession") : t("database.results.pinSession"),
        icon: record.pinned ? contextMenuIcons.unpin : contextMenuIcons.pin,
        onClick: () => {
          onPinSession(record.id, !record.pinned);
          void setSqlExecPinned(record.id, !record.pinned);
        },
      },
      {
        id: "close",
        label: t("database.results.closeSession"),
        icon: contextMenuIcons.close,
        onClick: () => {
          onCloseSession(record.id);
          void deleteSqlExecution(record.id);
        },
      },
    ];
  }, [connectionId, contextMenu?.id, items, onCloseSession, onInsertSql, onPinSession, t]);

  const renderRow = (record: SqlExecRecord, nested = false) => {
    const active = record.id === selected?.id;
    return (
      <button
        key={record.id}
        type="button"
        className={`flex w-full flex-col gap-0.5 border-b border-border/60 py-1.5 text-left ${
          nested ? "border-l border-border/70 py-1 pl-5 pr-2" : "px-2"
        } ${active ? "bg-accent/40" : "hover:bg-accent/20"}`}
        onClick={() => void openRecord(record)}
        onDoubleClick={() => {
          if (!record.pinned) {
            onPinSession(record.id, true);
            void setSqlExecPinned(record.id, true);
          }
        }}
        onContextMenu={(event: MouseEvent) => {
          event.preventDefault();
          setContextMenu({ x: event.clientX, y: event.clientY, id: record.id });
        }}
      >
        {nested ? null : (
          <span className="truncate text-[11px] text-foreground">
            {record.pinned ? "📌 " : ""}
            {record.displayName || record.sql}
          </span>
        )}
        <span className={`truncate text-muted-foreground ${nested ? "text-[11px]" : "text-[10px]"}`}>
          {nested && record.pinned ? "📌 " : ""}
          {formatSqlExecRelativeTime(record.executedAt, t, now)}
          {record.status === "error" ? ` · ${t("database.sqlExec.failed")}` : ""}
          {record.status === "cancelled" ? ` · ${t("database.sqlExec.cancelled")}` : ""}
          {record.resultTruncated ? ` · ${t("database.sqlExec.truncated")}` : ""}
          {record.elapsedMs != null ? ` · ${record.elapsedMs}ms` : ""}
        </span>
      </button>
    );
  };

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-[240px] shrink-0 flex-col border-r border-border">
        <div className="flex flex-col gap-1 border-b border-border p-1.5">
          <select
            className="h-6 rounded border border-border bg-background px-1 text-[11px]"
            value={kind}
            onChange={(event) => setKind(event.target.value)}
          >
            <option value="">{t("database.sqlExec.kindAll")}</option>
            <option value="select">SELECT</option>
            <option value="update">UPDATE</option>
            <option value="delete">DELETE</option>
            <option value="ddl">DDL</option>
          </select>
          <input
            className="h-6 rounded border border-border bg-background px-1 text-[11px]"
            value={tableName}
            placeholder={t("database.sqlExec.table")}
            onChange={(event) => setTableName(event.target.value)}
          />
          <WorkbenchActionButton onClick={() => setGroupBySql((value) => !value)}>
            {groupBySql ? t("database.sqlExec.flat") : t("database.sqlExec.groupBySql")}
          </WorkbenchActionButton>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {items.length === 0 ? (
            <div className="px-2 py-3 text-[11px] text-muted-foreground">{t("database.sqlExec.empty")}</div>
          ) : groupBySql ? (
            groups.map(([key, rows]) => (
              <div key={key}>
                <button
                  type="button"
                  className="flex w-full items-center gap-1 px-2 py-1 text-left text-[11px] hover:bg-accent/20"
                  onClick={() => setExpanded((prev) => ({ ...prev, [key]: !prev[key] }))}
                >
                  <span className="w-3 shrink-0 text-muted-foreground" aria-hidden>
                    {expanded[key] ? "▾" : "▸"}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{rows[0]?.displayName || key}</span>
                  <span className="shrink-0 text-muted-foreground">{rows.length}</span>
                </button>
                {expanded[key] ? rows.map((record) => renderRow(record, true)) : null}
              </div>
            ))
          ) : (
            items.map((record) => renderRow(record))
          )}
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        {selected?.resultTruncated ? (
          <div className="border-b border-border px-2 py-1 text-[11px] text-muted-foreground">
            {t("database.sqlExec.truncatedHint")}
          </div>
        ) : null}
        {viewSession ? (
          <SqlResultSessionPanel
            sqlTabId={sqlTabId}
            session={viewSession}
            detailCollapsed={detailCollapsed}
            selectionReporting
            gridActionsRef={gridActionsRef}
            onActiveCellChange={onActiveCellChange}
            onSelectedCellsChange={onSelectedCellsChange}
            onCellEditorFocusRequest={onCellEditorFocusRequest}
            onRowBandSelect={onRowBandSelect}
          />
        ) : (
          <div className="px-3 py-4 text-[12px] text-muted-foreground">{t("database.sqlExec.empty")}</div>
        )}
      </div>
      {contextMenu ? (
        <ContextMenu
          items={contextMenuItems}
          position={{ x: contextMenu.x, y: contextMenu.y }}
          onClose={() => setContextMenu(null)}
        />
      ) : null}
    </div>
  );
});
