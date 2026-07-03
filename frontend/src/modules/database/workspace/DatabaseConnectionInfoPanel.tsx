import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "../../../i18n";
import { appConfirm } from "../../../lib/appConfirm";
import { appAlert } from "../../../lib/appAlert";
import { textSearchMatches } from "../../../lib/textSearchMatch";
import { Button } from "../../../components/ui/Button";
import { ScopedSearch } from "../../../components/ui/ScopedSearch";
import { isMysqlConnectionInfoCapable, type DbConnectionConfig } from "../api";
import { makeQueryRunId } from "../sql/queryRun";
import { displayDetailValue } from "./databaseTablesPanelFormat";
import { rowsToRecord, type QueryResult } from "./dbWorkspaceState";

const PROCESSLIST_SQL = "SHOW FULL PROCESSLIST;";

type ProcessSortColumn = "user" | "host" | "db" | "time";
type ProcessSortDirection = "asc" | "desc";

interface ProcessSortState {
  column: ProcessSortColumn;
  direction: ProcessSortDirection;
}

const SORTABLE_COLUMN_CANDIDATES: Record<ProcessSortColumn, string[]> = {
  user: ["User"],
  host: ["Host"],
  db: ["db", "DB", "Db"],
  time: ["Time"],
};

const ID_COLUMN_CANDIDATES = ["Id", "ID", "id"];

interface DatabaseConnectionInfoPanelProps {
  connection: DbConnectionConfig;
  /** 当前 Tab 是否处于激活态；激活时自动拉取一次进程列表。 */
  active?: boolean;
}

function resolveColumnName(columns: string[], candidates: string[]): string | null {
  const byLower = new Map(columns.map((column) => [column.toLowerCase(), column]));
  for (const candidate of candidates) {
    const resolved = byLower.get(candidate.toLowerCase());
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

function formatProcessCell(value: unknown): string {
  if (value == null) {
    return "—";
  }
  if (typeof value === "object") {
    return displayDetailValue(JSON.stringify(value));
  }
  return displayDetailValue(String(value));
}

function resolveProcessId(row: Record<string, unknown>, idColumn: string | null): number | null {
  if (!idColumn) {
    return null;
  }
  const raw = row[idColumn];
  const num = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
  if (!Number.isFinite(num) || num <= 0) {
    return null;
  }
  return num;
}

function rowMatchesSearch(row: Record<string, unknown>, query: string): boolean {
  return Object.values(row).some((value) => {
    if (value == null) {
      return false;
    }
    return textSearchMatches(query, String(value));
  });
}

function sortHeaderClass(column: ProcessSortColumn, sort: ProcessSortState): string {
  if (sort.column !== column) {
    return " db-tables-panel-grid__sortable";
  }
  return sort.direction === "asc"
    ? " db-tables-panel-grid__sortable db-tables-panel-grid__sort-asc"
    : " db-tables-panel-grid__sortable db-tables-panel-grid__sort-desc";
}

function compareProcessRows(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  columnKey: string,
  column: ProcessSortColumn,
  direction: ProcessSortDirection,
): number {
  if (column === "time") {
    const aNum = Number(a[columnKey]);
    const bNum = Number(b[columnKey]);
    const aVal = Number.isFinite(aNum) ? aNum : -1;
    const bVal = Number.isFinite(bNum) ? bNum : -1;
    if (aVal !== bVal) {
      const cmp = aVal - bVal;
      return direction === "asc" ? cmp : -cmp;
    }
    return 0;
  }

  const cmp = formatProcessCell(a[columnKey]).localeCompare(
    formatProcessCell(b[columnKey]),
    undefined,
    { sensitivity: "base", numeric: true },
  );
  return direction === "asc" ? cmp : -cmp;
}

function resolveSortColumn(column: string, sortColumnKeys: Record<ProcessSortColumn, string | null>): ProcessSortColumn | null {
  for (const [sortColumn, key] of Object.entries(sortColumnKeys) as [ProcessSortColumn, string | null][]) {
    if (key === column) {
      return sortColumn;
    }
  }
  return null;
}

export function DatabaseConnectionInfoPanel({
  connection,
  active = true,
}: DatabaseConnectionInfoPanelProps) {
  const { t } = useI18n();
  const capable = isMysqlConnectionInfoCapable(connection);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(capable);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [sort, setSort] = useState<ProcessSortState>({ column: "time", direction: "desc" });
  const [killingId, setKillingId] = useState<number | null>(null);

  const refresh = useCallback(async (options?: { silent?: boolean }) => {
    if (!capable) {
      return;
    }

    const silent = options?.silent ?? false;
    if (!silent) {
      setLoading(true);
      setResult(null);
    }
    setError(null);
    try {
      const queryResult = await invoke<QueryResult>("db_execute_query", {
        connection,
        sql: PROCESSLIST_SQL,
        runId: makeQueryRunId(),
      });
      setResult(queryResult);
    } catch (e) {
      setError(typeof e === "string" ? e : JSON.stringify(e));
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  }, [capable, connection]);

  useEffect(() => {
    setSearch("");
    setSort({ column: "time", direction: "desc" });
  }, [connection.id]);

  useEffect(() => {
    if (!active || !capable) {
      return;
    }
    void refresh();
  }, [active, capable, connection.id, refresh]);

  const columns = result?.columns ?? [];
  const rows = useMemo(
    () => (result && columns.length > 0 ? rowsToRecord(columns, result.rows) : []),
    [columns, result],
  );

  const sortColumnKeys = useMemo(
    () =>
      ({
        user: resolveColumnName(columns, SORTABLE_COLUMN_CANDIDATES.user),
        host: resolveColumnName(columns, SORTABLE_COLUMN_CANDIDATES.host),
        db: resolveColumnName(columns, SORTABLE_COLUMN_CANDIDATES.db),
        time: resolveColumnName(columns, SORTABLE_COLUMN_CANDIDATES.time),
      }) satisfies Record<ProcessSortColumn, string | null>,
    [columns],
  );

  const idColumn = useMemo(() => resolveColumnName(columns, ID_COLUMN_CANDIDATES), [columns]);

  const filteredRows = useMemo(() => {
    const q = search.trim();
    if (!q) {
      return rows;
    }
    return rows.filter((row) => rowMatchesSearch(row, q));
  }, [rows, search]);

  const sortedRows = useMemo(() => {
    const sortKey = sortColumnKeys[sort.column];
    if (!sortKey) {
      return filteredRows;
    }
    const list = [...filteredRows];
    list.sort((a, b) => compareProcessRows(a, b, sortKey, sort.column, sort.direction));
    return list;
  }, [filteredRows, sort, sortColumnKeys]);

  const toggleSort = useCallback((column: ProcessSortColumn) => {
    setSort((prev) => {
      if (prev.column === column) {
        return { column, direction: prev.direction === "asc" ? "desc" : "asc" };
      }
      return {
        column,
        direction: column === "time" ? "desc" : "asc",
      };
    });
  }, []);

  const handleKill = useCallback(
    async (row: Record<string, unknown>) => {
      const id = resolveProcessId(row, idColumn);
      if (id == null || killingId != null) {
        return;
      }

      const user = formatProcessCell(row[sortColumnKeys.user ?? "User"]);
      const host = formatProcessCell(row[sortColumnKeys.host ?? "Host"]);
      const confirmed = await appConfirm(
        t("database.connectionInfo.killConfirm", { id: String(id), user, host }),
        t("database.connectionInfo.killConfirmTitle"),
        { confirmLabel: t("database.connectionInfo.kill") },
      );
      if (!confirmed) {
        return;
      }

      setKillingId(id);
      try {
        await invoke<QueryResult>("db_execute_query", {
          connection,
          sql: `KILL ${id};`,
          runId: makeQueryRunId(),
        });
        await refresh({ silent: true });
      } catch (e) {
        const message = typeof e === "string" ? e : JSON.stringify(e);
        void appAlert(message, t("database.connectionInfo.killFailed"));
      } finally {
        setKillingId(null);
      }
    },
    [connection, idColumn, killingId, refresh, sortColumnKeys.host, sortColumnKeys.user, t],
  );

  const panelBody = (content: ReactNode) => (
    <ScopedSearch
      className="db-tables-panel db-tables-panel--dock"
      value={search}
      onChange={setSearch}
      placeholder={t("database.connectionInfo.search")}
      enabled={capable}
    >
      <div className="db-tables-panel-body">
        <div className="db-tables-panel-grid-wrap">{content}</div>
      </div>
      <div className="db-tables-panel-meta">
        <Button variant="secondary" size="sm" onClick={() => void refresh()} disabled={loading || !capable}>
          {t("database.sidebar.refresh")}
        </Button>
        <span className="db-tables-panel-meta-text">
          {loading
            ? t("common.loading")
            : t("database.connectionInfo.count", { count: sortedRows.length })}
        </span>
      </div>
    </ScopedSearch>
  );

  if (!capable) {
    return panelBody(
      <div className="db-tables-panel-empty">
        {t("database.connectionInfo.unsupportedEngine", { engine: connection.db_type })}
      </div>,
    );
  }

  if (loading) {
    return panelBody(<div className="db-tables-panel-empty">{t("common.loading")}</div>);
  }

  if (error) {
    return panelBody(<div className="db-tables-panel-error">{error}</div>);
  }

  if (columns.length === 0 || rows.length === 0) {
    return panelBody(
      <div className="db-tables-panel-empty">{t("database.connectionInfo.empty")}</div>,
    );
  }

  return panelBody(
    <>
      {sortedRows.length === 0 ? (
        <div className="db-tables-panel-empty">{t("database.connectionInfo.noResults")}</div>
      ) : (
        <table className="db-tables-panel-grid db-tables-panel-grid--processlist">
          <thead>
            <tr>
              {columns.map((column, index) => {
                const sortColumn = resolveSortColumn(column, sortColumnKeys);
                const sortable = sortColumn != null;
                return (
                  <th
                    key={column}
                    className={[
                      index === 0 ? "db-tables-panel-grid__name-col" : "",
                      sortable && sortColumn ? sortHeaderClass(sortColumn, sort).trim() : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    onClick={sortable && sortColumn ? () => toggleSort(sortColumn) : undefined}
                    aria-sort={
                      sortable && sortColumn && sort.column === sortColumn
                        ? sort.direction === "asc"
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                  >
                    {sortable && sortColumn ? (
                      <span className="db-tables-panel-grid__th-label">
                        {column}
                        {sort.column === sortColumn ? (
                          <span className="db-tables-panel-grid__sort-mark" aria-hidden>
                            {sort.direction === "asc" ? "↑" : "↓"}
                          </span>
                        ) : null}
                      </span>
                    ) : (
                      column
                    )}
                  </th>
                );
              })}
              <th
                className="db-tables-panel-grid__actions-col db-tables-panel-grid__actions-col--sticky"
                aria-label={t("database.connectionInfo.actions")}
              >
                {t("database.connectionInfo.actions")}
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row, rowIndex) => {
              const processId = resolveProcessId(row, idColumn);
              const isKilling = processId != null && killingId === processId;
              return (
                <tr key={processId ?? rowIndex}>
                  {columns.map((column, columnIndex) => {
                    const value = formatProcessCell(row[column]);
                    return (
                      <td
                        key={column}
                        className={columnIndex === 0 ? "db-tables-panel-grid__name" : undefined}
                        title={value}
                      >
                        {value}
                      </td>
                    );
                  })}
                  <td className="db-tables-panel-grid__actions-col db-tables-panel-grid__actions-col--sticky">
                    <Button
                      variant="danger"
                      size="xs"
                      disabled={processId == null || killingId != null}
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleKill(row);
                      }}
                    >
                      {isKilling ? t("database.connectionInfo.killing") : t("database.connectionInfo.kill")}
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>,
  );
}
