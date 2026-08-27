import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "../../../i18n";
import type { DbConnectionConfig } from "../api";
import { slowQuerySqls } from "../dialectWorkbenchSql";
import { makeQueryRunId } from "../sql/queryRun";
import { DbTablesPanelGrid, type DbTablesPanelGridColumn } from "./DbTablesPanelGrid";
import { rowsToRecord, type QueryResult } from "./dbWorkspaceState";

export function DialectSlowQueryPanel({
  connection,
  active = true,
}: {
  connection: DbConnectionConfig;
  active?: boolean;
}) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [result, setResult] = useState<QueryResult | null>(null);

  const refresh = useCallback(async () => {
    const sqls = slowQuerySqls(connection.db_type);
    if (sqls.length === 0) {
      setResult({ columns: [], rows: [], rowsAffected: 0 });
      setHint(t("database.slowQueryLog.dialectUnsupported"));
      return;
    }
    setLoading(true);
    setError(null);
    setHint(null);
    let lastError = "";
    for (const sql of sqls) {
      try {
        const queryResult = await invoke<QueryResult>("db_execute_query", {
          connection,
          sql,
          runId: makeQueryRunId(),
        });
        setResult(queryResult);
        if (queryResult.rows.length === 0) {
          setHint(t("database.slowQueryLog.dialectEmpty"));
        }
        setLoading(false);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    setResult({ columns: [], rows: [], rowsAffected: 0 });
    setHint(t("database.slowQueryLog.dialectMissing"));
    setError(lastError || null);
    setLoading(false);
  }, [connection, t]);

  useEffect(() => {
    if (!active) return;
    void refresh();
  }, [active, refresh]);

  const columns = result?.columns ?? [];
  const rows = useMemo(
    () => (result && columns.length > 0 ? rowsToRecord(columns, result.rows) : []),
    [result, columns],
  );
  const gridColumns = useMemo<DbTablesPanelGridColumn<Record<string, unknown>>[]>(
    () =>
      columns.map((id) => ({
        id,
        header: id,
        sortable: false,
        defaultWidth: 160,
        minWidth: 80,
        render: (row) => String(row[id] ?? "—"),
        getTitle: (row) => String(row[id] ?? ""),
        getCopyValue: (row) => String(row[id] ?? ""),
      })),
    [columns],
  );

  if (loading && !result) {
    return <div className="db-tables-panel-empty">{t("database.slowQueryLog.loading")}</div>;
  }

  return (
    <div className="db-workspace-pane db-dock-pane">
      {error ? <div className="db-tables-panel-error">{error}</div> : null}
      {hint && rows.length === 0 ? (
        <div className="db-tables-panel-empty">{hint}</div>
      ) : (
        <DbTablesPanelGrid
          rows={rows}
          rowKey={(_, index) => index}
          columns={gridColumns}
        />
      )}
    </div>
  );
}
