import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from "react";
import type { PanelImperativeHandle, PanelSize } from "react-resizable-panels";
import { Select } from "../../../components/ui/form/Select";
import { ContextMenu, type ContextMenuItem } from "../../../components/ui/menu/ContextMenu";
import { contextMenuIcons } from "../../../components/ui/menu/contextMenuIcons";
import { useI18n } from "../../../i18n";
import type { SqlResultSession } from "../workspace/dbWorkspaceState";
import type { TableDataGridActiveCell, TableDataGridActions } from "../grid/TableDataGrid";
import { SqlResultSessionPanel } from "./SqlResultSessionPanel";
import type { MutableRefObject } from "react";
import {
  deleteSqlExecution,
  formatSqlExecRelativeTime,
  getSqlExecResult,
  sqlExecDisplayName,
  importLegacySqlQueryHistory,
  listSqlExecutions,
  setSqlExecPinned,
  subscribeSqlExecLog,
  type SqlExecRecord,
} from "./sqlExecLog";
import { openSqlInNewQuery } from "../schema/tableObjectActions";
import { extractTableRefsFromRegex } from "../sqlEditor/parser/analyzer";
import { isQueryCancelledError } from "./queryRun";

type SqlExecGroupMode = "flat" | "sql" | "database" | "table";

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
  onHighlightSql?: (sql: string) => void;
  detailCollapsed?: boolean;
  gridActionsRef?: MutableRefObject<TableDataGridActions | null>;
  onActiveCellChange?: (cell: TableDataGridActiveCell | null) => void;
  onSelectedCellsChange?: (cells: TableDataGridActiveCell[]) => void;
  onCellEditorFocusRequest?: () => void;
  onRowBandSelect?: () => void;
  onToggleDetail?: () => void;
  detail?: ReactNode;
  detailPosition?: "right" | "bottom";
  detailDefaultSize?: number | string;
  detailMinSize?: number | string;
  detailPanelRef?: RefObject<PanelImperativeHandle | null>;
  onDetailResize?: (size: PanelSize) => void;
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
    displayName: sqlExecDisplayName(session.sql, "SQL"),
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
  onHighlightSql,
  detailCollapsed = true,
  gridActionsRef,
  onActiveCellChange,
  onSelectedCellsChange,
  onCellEditorFocusRequest,
  onRowBandSelect,
  onToggleDetail,
  detail,
  detailPosition,
  detailDefaultSize,
  detailMinSize,
  detailPanelRef,
  onDetailResize,
}: SqlResultSessionsDockProps) {
  const { t } = useI18n();
  const [records, setRecords] = useState<SqlExecRecord[]>([]);
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("");
  const [keyword, setKeyword] = useState("");
  const [groupMode, setGroupMode] = useState<SqlExecGroupMode>("flat");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [storedView, setStoredView] = useState<SqlResultSession | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(activeSessionId);
  const [seenAt] = useState(() => new Map<string, number>());
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const followedActiveIdRef = useRef<string | null>(null);
  const wasRunningRef = useRef(false);
  const runningIdsRef = useRef<Set<string>>(new Set());

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
      status: status || null,
      keyword: keyword.trim() || null,
      limit: 200,
    });
    setRecords(rows);
  }, [keyword, kind, sqlFileId, sqlTabId, status]);

  useEffect(() => {
    void reload();
    return subscribeSqlExecLog(() => {
      void reload();
    });
  }, [reload]);

  useEffect(() => {
    const runningIds = new Set(sessions.filter((item) => item.running).map((item) => item.id));
    const finishedIds = [...runningIdsRef.current].filter((id) => !runningIds.has(id));
    runningIdsRef.current = runningIds;
    if (!status || finishedIds.length === 0) return;
    for (const id of finishedIds) {
      const session = sessions.find((item) => item.id === id);
      if (!session || session.running) continue;
      const outcome = session.error
        ? isQueryCancelledError(session.error)
          ? "cancelled"
          : "error"
        : "ok";
      if (outcome !== status) {
        setStatus("");
        return;
      }
    }
  }, [sessions, status]);

  const runningNow = sessions.some((item) => item.running);
  if (runningNow && !wasRunningRef.current) {
    const at = Date.now();
    followedActiveIdRef.current = null;
    for (const session of sessions) {
      if (session.running) seenAt.set(session.id, at);
    }
  }
  wasRunningRef.current = runningNow;

  const items = useMemo(() => {
    const byId = new Map(records.map((row) => [row.id, row]));
    for (const session of sessions) {
      if (session.executionId && byId.has(session.executionId)) continue;
      if (!session.running && !session.executionId) continue;
      if (!seenAt.has(session.id)) seenAt.set(session.id, Date.now());
      const row = liveRecord(session, seenAt.get(session.id) ?? Date.now());
      byId.set(session.executionId ?? session.id, {
        ...row,
        id: session.executionId ?? session.id,
        status: session.running ? "ok" : row.status,
      });
    }
    const needle = keyword.trim().toLowerCase();
    return [...byId.values()]
      .filter((item) => !status || item.status === status)
      .filter((item) => !needle || item.sql.toLowerCase().includes(needle) || item.displayName.toLowerCase().includes(needle))
      .sort((a, b) => b.executedAt - a.executedAt || b.id.localeCompare(a.id));
  }, [keyword, records, seenAt, sessions, status]);

  const groups = useMemo(() => {
    if (groupMode === "flat") return [];
    const map = new Map<string, SqlExecRecord[]>();
    for (const item of items) {
      const key =
        groupMode === "sql"
          ? statementKey(item.sql)
          : groupMode === "database"
            ? item.databaseName.trim() || "\0"
            : extractTableRefsFromRegex(item.sql)[0]?.tableName || "\0";
      const list = map.get(key);
      if (list) list.push(item);
      else map.set(key, [item]);
    }
    return [...map.entries()];
  }, [groupMode, items]);

  const runningSession = sessions.find((item) => item.running);
  const preferredId = runningSession
    ? (runningSession.executionId ?? runningSession.id)
    : selectedId;
  const selected = items.find((item) => item.id === preferredId) ?? items[0];
  const liveSession = sessions.find(
    (item) => item.executionId === selected?.id || (item.running && item.id === selected?.id),
  );
  const viewSession = liveSession ?? (storedView?.id === selected?.id ? storedView : null);

  const openRecord = useCallback(
    async (record: SqlExecRecord) => {
      setSelectedId(record.id);
      onHighlightSql?.(record.sql);
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
    [onActiveSessionChange, onHighlightSql, sessions, t],
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
        title={record.sql}
        onContextMenu={(event: MouseEvent) => {
          event.preventDefault();
          setContextMenu({ x: event.clientX, y: event.clientY, id: record.id });
        }}
      >
        {nested ? null : (
          <span className="flex min-w-0 items-center gap-1 text-[11px] text-foreground">
            <span
              className={`sql-exec-status sql-exec-status--${record.status === "error" || record.status === "cancelled" ? record.status : "ok"}`}
              title={
                record.status === "error"
                  ? t("database.sqlExec.failed")
                  : record.status === "cancelled"
                    ? t("database.sqlExec.cancelled")
                    : t("database.sqlExec.statusOk")
              }
            />
            <span className="truncate">
            {record.pinned ? "📌 " : ""}
            {sqlExecDisplayName(record.sql, record.displayName || "SQL")}
            </span>
          </span>
        )}
        <span className={`flex min-w-0 items-center gap-1 truncate text-muted-foreground ${nested ? "text-[11px]" : "text-[10px]"}`}>
          {nested ? (
            <span
              className={`sql-exec-status sql-exec-status--${record.status === "error" || record.status === "cancelled" ? record.status : "ok"}`}
            />
          ) : null}
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
          <div className="flex min-w-0 gap-1">
            <Select
              className="db-select min-w-0 flex-1"
              size="sm"
              value={status}
              onChange={setStatus}
              panelMinWidth={160}
              title={t("database.sqlExec.statusAll")}
              options={[
                { value: "", label: t("database.sqlExec.statusAll") },
                { value: "ok", label: t("database.sqlExec.statusOk") },
                { value: "error", label: t("database.sqlExec.failed") },
                { value: "cancelled", label: t("database.sqlExec.cancelled") },
              ]}
            />
            <Select
              className="db-select min-w-0 flex-1"
              size="sm"
              value={kind}
              onChange={setKind}
              panelMinWidth={160}
              title={t("database.sqlExec.kindAll")}
              options={[
                { value: "", label: t("database.sqlExec.kindAll") },
                { value: "select", label: "SELECT" },
                { value: "update", label: "UPDATE" },
                { value: "delete", label: "DELETE" },
                { value: "ddl", label: "DDL" },
              ]}
            />
          </div>
          <input
            className="h-6 rounded border border-border bg-background px-1.5 text-[11px] outline-none focus:border-foreground/30"
            value={keyword}
            placeholder={t("database.sqlExec.keyword")}
            onChange={(event) => setKeyword(event.target.value)}
          />
          <div className="grid grid-cols-4" role="tablist">
            {(
              [
                ["flat", t("database.sqlExec.groupFlat")],
                ["sql", t("database.sqlExec.groupSql")],
                ["database", t("database.sqlExec.groupDb")],
                ["table", t("database.sqlExec.groupTable")],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                role="tab"
                aria-selected={groupMode === mode}
                className={`h-6 border-b text-[11px] outline-none ${
                  groupMode === mode
                    ? "border-foreground text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setGroupMode(mode)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {items.length === 0 ? (
            <div className="px-2 py-3 text-[11px] text-muted-foreground">{t("database.sqlExec.empty")}</div>
          ) : groupMode === "flat" ? (
            items.map((record) => renderRow(record))
          ) : (
            groups.map(([key, rows]) => {
              const label =
                groupMode === "sql"
                  ? sqlExecDisplayName(rows[0]?.sql ?? key, rows[0]?.displayName || "SQL")
                  : key === "\0"
                    ? t(groupMode === "table" ? "database.sqlExec.groupNoTable" : "database.sqlExec.groupNoDb")
                    : key;
              return (
              <div key={key}>
                <button
                  type="button"
                  title={groupMode === "sql" ? rows[0]?.sql : label}
                  className="flex w-full items-center gap-1 px-2 py-1 text-left text-[11px] hover:bg-accent/20"
                  onClick={() => setExpanded((prev) => ({ ...prev, [key]: !prev[key] }))}
                >
                  <span className="w-3 shrink-0 text-muted-foreground" aria-hidden>
                    {expanded[key] ? "▾" : "▸"}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  <span className="shrink-0 text-muted-foreground">{rows.length}</span>
                </button>
                {expanded[key] ? rows.map((record) => renderRow(record, true)) : null}
              </div>
              );
            })
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
            onToggleDetail={onToggleDetail}
            detail={detail}
            detailPosition={detailPosition}
            detailDefaultSize={detailDefaultSize}
            detailMinSize={detailMinSize}
            detailPanelRef={detailPanelRef}
            onDetailResize={onDetailResize}
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
