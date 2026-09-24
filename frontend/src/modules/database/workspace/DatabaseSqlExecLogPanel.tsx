import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../../../i18n";
import { appConfirm } from "../../../lib/appConfirm";
import { WorkbenchActionButton } from "../../../components/ui/primitives/WorkbenchActionButton";
import { WorkbenchPanelHeader } from "../../../components/ui/primitives/WorkbenchPanelHeader";
import type { DbConnectionConfig } from "../api";
import { SqlResultSessionPanel } from "../sql/SqlResultSessionPanel";
import {
  clearSqlExecutions,
  formatSqlExecRelativeTime,
  getSqlExecResult,
  insertSqlAtActiveCursor,
  listSqlExecutions,
  openSqlExecutionSource,
  subscribeSqlExecLog,
  type SqlExecRecord,
} from "../sql/sqlExecLog";
import { openSqlInNewQuery } from "../schema/tableObjectActions";
import type { SqlResultSession } from "./dbWorkspaceState";

export function DatabaseSqlExecLogPanel({
  connection,
  active,
}: {
  connection: DbConnectionConfig;
  active: boolean;
}) {
  const { t } = useI18n();
  const [records, setRecords] = useState<SqlExecRecord[]>([]);
  const [kind, setKind] = useState("");
  const [databaseName, setDatabaseName] = useState("");
  const [keyword, setKeyword] = useState("");
  const [tableName, setTableName] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<SqlResultSession | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const reload = useCallback(async () => {
    const rows = await listSqlExecutions({
      connectionId: connection.id,
      kind: kind || null,
      databaseName: databaseName.trim() || null,
      keyword: keyword.trim() || null,
      tableName: tableName.trim() || null,
      fromMs: from ? new Date(from).getTime() : null,
      toMs: to ? new Date(to).getTime() : null,
      limit: 300,
    });
    setRecords(rows);
  }, [connection.id, databaseName, from, kind, keyword, tableName, to]);

  useEffect(() => {
    if (!active) return;
    void reload();
    return subscribeSqlExecLog(() => {
      void reload();
    });
  }, [active, reload]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const selected = records.find((row) => row.id === selectedId) ?? null;

  const open = async (record: SqlExecRecord) => {
    setSelectedId(record.id);
    if (!record.hasResult || record.status !== "ok") {
      setView({
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
    setView({
      id: record.id,
      sql: record.sql,
      result: page
        ? { columns: page.columns, rows: page.rows, rowsAffected: page.rowsAffected }
        : null,
      error: null,
      elapsed: record.elapsedMs,
      running: false,
      resultPage: 0,
      resultHasMore: false,
      pinned: record.pinned,
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <WorkbenchPanelHeader
        label={t("database.sqlExec.connLog")}
        tags={[{ text: connection.name, emphasis: true }]}
        actions={
          <WorkbenchActionButton
            danger
            onClick={() => {
              void (async () => {
                const ok = await appConfirm(t("database.sqlExec.clearConfirm"));
                if (!ok) return;
                await clearSqlExecutions(connection.id);
                setView(null);
                setSelectedId(null);
              })();
            }}
          >
            {t("database.sqlExec.clear")}
          </WorkbenchActionButton>
        }
      />
      <div className="flex flex-wrap items-center gap-1 border-b border-border px-2 py-1">
        <input
          className="h-6 rounded border border-border bg-background px-1 text-[11px]"
          type="datetime-local"
          value={from}
          aria-label={t("database.sqlExec.from")}
          onChange={(event) => setFrom(event.target.value)}
        />
        <input
          className="h-6 rounded border border-border bg-background px-1 text-[11px]"
          type="datetime-local"
          value={to}
          aria-label={t("database.sqlExec.to")}
          onChange={(event) => setTo(event.target.value)}
        />
        <input
          className="h-6 w-28 rounded border border-border bg-background px-1 text-[11px]"
          value={databaseName}
          placeholder={t("database.sqlExec.database")}
          onChange={(event) => setDatabaseName(event.target.value)}
        />
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
          className="h-6 w-36 rounded border border-border bg-background px-1 text-[11px]"
          value={keyword}
          placeholder={t("database.sqlExec.keyword")}
          onChange={(event) => setKeyword(event.target.value)}
        />
        <input
          className="h-6 w-28 rounded border border-border bg-background px-1 text-[11px]"
          value={tableName}
          placeholder={t("database.sqlExec.table")}
          onChange={(event) => setTableName(event.target.value)}
        />
        <WorkbenchActionButton
          onClick={() => {
            setKind("");
            setDatabaseName("");
            setKeyword("");
            setTableName("");
            setFrom("");
            setTo("");
          }}
        >
          {t("database.sqlExec.resetFilters")}
        </WorkbenchActionButton>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="w-[260px] shrink-0 overflow-auto border-r border-border">
          {records.length === 0 ? (
            <div className="px-2 py-3 text-[11px] text-muted-foreground">{t("database.sqlExec.empty")}</div>
          ) : (
            records.map((record) => (
              <button
                key={record.id}
                type="button"
                className={`flex w-full flex-col gap-0.5 border-b border-border/60 px-2 py-1.5 text-left ${
                  record.id === selected?.id ? "bg-accent/40" : "hover:bg-accent/20"
                }`}
                onClick={() => void open(record)}
              >
                <span className="truncate text-[11px]">{record.displayName || record.sql}</span>
                <span className="truncate text-[10px] text-muted-foreground">
                  {formatSqlExecRelativeTime(record.executedAt, t, now)}
                  {record.databaseName ? ` · ${record.databaseName}` : ""}
                  {record.resultTruncated ? ` · ${t("database.sqlExec.truncated")}` : ""}
                </span>
              </button>
            ))
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          {selected ? (
            <div className="flex gap-1 border-b border-border px-2 py-1">
              <WorkbenchActionButton
                onClick={() => {
                  if (!insertSqlAtActiveCursor(selected.sql)) {
                    openSqlInNewQuery(connection.id, selected.databaseName, selected.sql);
                  }
                }}
              >
                {t("database.sqlExec.fillBack")}
              </WorkbenchActionButton>
              <WorkbenchActionButton
                onClick={() => openSqlInNewQuery(connection.id, selected.databaseName, selected.sql)}
              >
                {t("database.sqlExec.openNew")}
              </WorkbenchActionButton>
              {selected.sqlFileId ? (
                <WorkbenchActionButton onClick={() => openSqlExecutionSource(selected.sqlFileId)}>
                  {t("database.sqlExec.openSource")}
                </WorkbenchActionButton>
              ) : null}
            </div>
          ) : null}
          {selected?.resultTruncated ? (
            <div className="border-b border-border px-2 py-1 text-[11px] text-muted-foreground">
              {t("database.sqlExec.truncatedHint")}
            </div>
          ) : null}
          {view ? (
            <SqlResultSessionPanel sqlTabId={connection.id} session={view} detailCollapsed />
          ) : (
            <div className="px-3 py-4 text-[12px] text-muted-foreground">{t("database.sqlExec.empty")}</div>
          )}
        </div>
      </div>
    </div>
  );
}
