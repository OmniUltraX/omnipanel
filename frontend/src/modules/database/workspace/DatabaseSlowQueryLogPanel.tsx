import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { MultiSelect } from "../../../components/ui/form/MultiSelect";
import { useI18n } from "../../../i18n";
import { useConnectionStore } from "../../../stores/connectionStore";
import { listDatabases, listTables, type DbConnectionConfig } from "../api";
import {
  MYSQL_SLOW_LOG_CHUNK_BYTES,
  probeSlowLogAvailability,
  readMysqlSlowLogFileSize,
  readMysqlSlowLogNewest,
  readMysqlSlowLogRange,
  slowLogPageByteRange,
  slowLogTotalPages,
} from "../mysqlSlowQueryLog";
import {
  compileSlowLogFilter,
  EMPTY_SLOW_LOG_FILTERS,
  hasActiveSlowLogFilters,
  type SlowLogFilters,
} from "../slowLogFilters";

interface SlowLogCacheValue {
  text: string;
  fileSize: number;
  pageLength: number;
  page: number;
}
const slowLogCache = new Map<string, SlowLogCacheValue>();

interface SlowQueryEntry {
  time: string;
  userHost: string;
  queryTime: number;
  lockTime: number;
  rowsSent: number;
  rowsExamined: number;
  sql: string;
  count: number;
}

interface DatabaseSlowQueryLogPanelProps {
  connection: DbConnectionConfig;
  sshConnectionId: string;
  logFilePath: string;
  deploymentKind?: "host" | "docker";
  containerId?: string;
  active: boolean;
}

type ResolvedDeployment = {
  deploymentKind: "host" | "docker";
  containerId?: string;
};

const SQL_KEYWORDS = new Set([
  "SELECT", "FROM", "WHERE", "AND", "OR", "NOT", "IN", "IS", "NULL",
  "AS", "ON", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "CROSS",
  "FULL", "GROUP", "BY", "HAVING", "ORDER", "ASC", "DESC",
  "LIMIT", "OFFSET", "INSERT", "INTO", "VALUES", "UPDATE", "SET",
  "DELETE", "CREATE", "TABLE", "DROP", "ALTER", "ADD", "COLUMN",
  "INDEX", "VIEW", "IF", "EXISTS", "PRIMARY", "KEY", "FOREIGN",
  "REFERENCES", "CONSTRAINT", "UNIQUE", "CHECK", "DEFAULT",
  "CASE", "WHEN", "THEN", "ELSE", "END", "BEGIN", "COMMIT",
  "ROLLBACK", "TRANSACTION", "LOCK", "UNLOCK", "TABLES",
  "GRANT", "REVOKE", "UNION", "ALL", "DISTINCT", "TOP",
  "LIKE", "BETWEEN", "EXISTS", "ANY", "SOME", "TRUE", "FALSE",
  "COUNT", "SUM", "AVG", "MIN", "MAX", "COALESCE", "CAST",
  "ROW_NUMBER", "RANK", "DENSE_RANK", "OVER", "PARTITION",
  "WITH", "RECURSIVE", "EXPLAIN", "ANALYZE", "SHOW", "USE",
  "DESCRIBE", "CASCADE", "RESTRICT", "SERIALIZABLE", "COMMITTED",
  "READ", "WRITE", "REPEATABLE", "SNAPSHOT", "ISOLATION", "LEVEL",
  "MATERIALIZED", "TEMP", "TEMPORARY", "SCHEMA", "DATABASE",
  "TRUNCATE", "REPLACE", "MERGE", "DO", "RETURNING", "CONFLICT",
  "EXCEPT", "INTERSECT",
]);

const SQL_HIGHLIGHT_LIMIT = 8000;
const SLOW_LOG_ROW_HEIGHT = 32;

function highlightSql(sql: string): string {
  const source = sql.length > SQL_HIGHLIGHT_LIMIT ? sql.slice(0, SQL_HIGHLIGHT_LIMIT) : sql;
  const tail =
    sql.length > SQL_HIGHLIGHT_LIMIT
      ? sql
          .slice(SQL_HIGHLIGHT_LIMIT)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
      : "";
  let escaped = source
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  escaped = escaped.replace(
    /(--[^\n]*)|('(?:[^'\\]|\\.)*')|(\b\d+(?:\.\d+)?\b)|(\b[A-Z_][A-Z0-9_]*\b)/g,
    (match, comment, str, num, word) => {
      if (comment) return `<span class="sql-hl-comment">${comment}</span>`;
      if (str) return `<span class="sql-hl-string">${str}</span>`;
      if (num) return `<span class="sql-hl-number">${num}</span>`;
      if (word && SQL_KEYWORDS.has(word)) return `<span class="sql-hl-keyword">${word}</span>`;
      return match;
    },
  );
  return escaped + tail;
}

function parseSlowQueryLog(text: string): SlowQueryEntry[] {
  const entries: SlowQueryEntry[] = [];
  const blocks = text.split(/(?=^# Time:)/m);
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    const timeMatch = trimmed.match(/^# Time:\s*(.+)$/m);
    const userHostMatch = trimmed.match(/^# User@Host:\s*(.+)$/m);
    const metricsMatch = trimmed.match(
      /^# Query_time:\s*([\d.]+)\s+Lock_time:\s*([\d.]+)\s+Rows_sent:\s*(\d+)\s+Rows_examined:\s*(\d+)/m,
    );
    const sqlStart = trimmed.search(/(?:^|\n)(SET timestamp=\d+;\n?)?((?:(?!^# Time:)[\s\S])+)$/);
    let sql = "";
    if (sqlStart >= 0) {
      sql = trimmed.slice(sqlStart).replace(/^SET timestamp=\d+;\n?/m, "").trim();
    }

    if (timeMatch || metricsMatch) {
      entries.push({
        time: timeMatch?.[1]?.trim() ?? "",
        userHost: userHostMatch?.[1]?.trim() ?? "",
        queryTime: metricsMatch ? Number.parseFloat(metricsMatch[1]) : 0,
        lockTime: metricsMatch ? Number.parseFloat(metricsMatch[2]) : 0,
        rowsSent: metricsMatch ? Number.parseInt(metricsMatch[3], 10) : 0,
        rowsExamined: metricsMatch ? Number.parseInt(metricsMatch[4], 10) : 0,
        sql,
        count: 1,
      });
    }
  }
  return entries;
}

/** 去掉块首不完整的慢查询条目（跨页切分时可能出现）。 */
function trimPartialLeadingEntry(text: string): string {
  const idx = text.indexOf("# Time:");
  if (idx <= 0) return text;
  return text.slice(idx);
}

function mergeConsecutiveEntries(entries: SlowQueryEntry[]): SlowQueryEntry[] {
  if (entries.length === 0) return [];
  const merged: SlowQueryEntry[] = [entries[0]];
  for (let i = 1; i < entries.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = entries[i];
    if (curr.sql === prev.sql) {
      prev.count += curr.count;
      prev.queryTime = Math.max(prev.queryTime, curr.queryTime);
      prev.lockTime = Math.max(prev.lockTime, curr.lockTime);
      prev.rowsSent += curr.rowsSent;
      prev.rowsExamined += curr.rowsExamined;
    } else {
      merged.push(curr);
    }
  }
  return merged;
}

const SYSTEM_DB_SKIP = new Set(["information_schema", "performance_schema", "mysql", "sys"]);

function formatDuration(seconds: number): string {
  if (seconds < 1) return `${(seconds * 1000).toFixed(0)}ms`;
  return `${seconds.toFixed(2)}s`;
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // ignore
  }
}

function SlowQueryDetail({ entry }: { entry: SlowQueryEntry }) {
  const { t } = useI18n();
  const highlighted = useMemo(() => highlightSql(entry.sql), [entry.sql]);
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    void copyText(entry.sql).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [entry.sql]);

  return (
    <div className="db-slow-log-panel__detail">
      <div className="db-slow-log-panel__detail-bar">
        <span className="db-slow-log-panel__detail-meta">{entry.time || "—"}</span>
        <span className="db-slow-log-panel__detail-meta">
          {t("database.slowQueryLog.tagQuery")}: {formatDuration(entry.queryTime)}
        </span>
        <span className="db-slow-log-panel__detail-meta">
          {t("database.slowQueryLog.tagLock")}: {formatDuration(entry.lockTime)}
        </span>
        <span className="db-slow-log-panel__detail-meta">
          {t("database.slowQueryLog.tagSent")}: {entry.rowsSent.toLocaleString()}
        </span>
        <span className="db-slow-log-panel__detail-meta">
          {t("database.slowQueryLog.tagExamined")}: {entry.rowsExamined.toLocaleString()}
        </span>
        {entry.count > 1 ? (
          <span className="db-slow-log-panel__detail-meta">{entry.count}x</span>
        ) : null}
        <span className="db-slow-log-panel__detail-user">{entry.userHost}</span>
        <button
          type="button"
          className="log-viewer-panel__btn"
          onClick={handleCopy}
        >
          {copied ? t("database.slowQueryLog.copied") : t("database.slowQueryLog.copy")}
        </button>
      </div>
      <pre
        className="db-slow-log-panel__detail-sql"
        dangerouslySetInnerHTML={{ __html: highlighted }}
      />
    </div>
  );
}

export function DatabaseSlowQueryLogPanel({
  connection,
  sshConnectionId,
  logFilePath,
  deploymentKind: initialDeploymentKind,
  containerId: initialContainerId,
  active,
}: DatabaseSlowQueryLogPanelProps) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileSize, setFileSize] = useState<number | null>(null);
  const [pageLength, setPageLength] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [filters, setFilters] = useState<SlowLogFilters>(EMPTY_SLOW_LOG_FILTERS);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [databaseOptions, setDatabaseOptions] = useState<string[]>([]);
  const [tableOptions, setTableOptions] = useState<string[]>([]);
  const loadedBytesRef = useRef(0);
  const loadingRef = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  const fileSizeRef = useRef<number | null>(fileSize);
  fileSizeRef.current = fileSize;
  const deploymentRef = useRef<ResolvedDeployment | null>(
    initialDeploymentKind
      ? { deploymentKind: initialDeploymentKind, containerId: initialContainerId }
      : null,
  );

  const cacheKey = `${sshConnectionId}::${logFilePath}::${initialDeploymentKind ?? ""}::${initialContainerId ?? ""}`;

  const resolveDeployment = useCallback(async (): Promise<ResolvedDeployment> => {
    const cached = deploymentRef.current;
    if (cached?.deploymentKind === "docker" && cached.containerId) {
      return cached;
    }
    if (cached?.deploymentKind === "host") {
      return cached;
    }

    const sshConnections = useConnectionStore
      .getState()
      .connections.filter((conn) => conn.kind === "ssh");
    const availability = await probeSlowLogAvailability(connection, sshConnections);
    const resolved: ResolvedDeployment =
      availability.deploymentKind === "docker" && availability.containerId
        ? { deploymentKind: "docker", containerId: availability.containerId }
        : { deploymentKind: "host" };

    deploymentRef.current = resolved;
    return resolved;
  }, [connection]);

  const loadPage = useCallback(
    async (page: number) => {
      if (loadingRef.current) return;

      loadingRef.current = true;
      setLoading(true);
      setError(null);
      try {
        const deployment = await resolveDeployment();
        let size = 0;
        let raw = "";
        if (page === 1) {
          const newest = await readMysqlSlowLogNewest(
            sshConnectionId,
            logFilePath,
            MYSQL_SLOW_LOG_CHUNK_BYTES,
            deployment.deploymentKind,
            deployment.containerId,
          );
          size = newest.size;
          raw = newest.text;
        } else {
          size =
            fileSizeRef.current ??
            (await readMysqlSlowLogFileSize(
              sshConnectionId,
              logFilePath,
              deployment.deploymentKind,
              deployment.containerId,
            ));
          const safe = Math.max(1, Math.min(page, slowLogTotalPages(size)));
          const range = slowLogPageByteRange(safe, size);
          raw =
            range.length > 0
              ? await readMysqlSlowLogRange(
                  sshConnectionId,
                  logFilePath,
                  range.start,
                  range.length,
                  deployment.deploymentKind,
                  deployment.containerId,
                )
              : "";
        }
        setFileSize(size);

        const safePage = Math.max(1, Math.min(page, slowLogTotalPages(size)));
        const { length } = slowLogPageByteRange(safePage, size);
        const chunk = trimPartialLeadingEntry(raw);
        setText(chunk);
        setPageLength(length);
        loadedBytesRef.current = length;
        if (size > 0 && length > 0 && !chunk.trim()) {
          setError(t("database.slowQueryLog.readEmptyHint"));
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
        loadingRef.current = false;
      }
    },
    [logFilePath, resolveDeployment, sshConnectionId, t],
  );

  const totalPages = useMemo(() => {
    if (fileSize === null || fileSize <= 0) return 1;
    return slowLogTotalPages(fileSize);
  }, [fileSize]);

  const safePage = Math.min(Math.max(currentPage, 1), totalPages);

  const goToPage = useCallback(
    (page: number) => {
      const nextPage = Math.max(1, Math.min(page, totalPages));
      setCurrentPage(nextPage);
      if (listRef.current) {
        listRef.current.scrollTop = 0;
      }
      void loadPage(nextPage);
    },
    [loadPage, totalPages],
  );

  useEffect(() => {
    if (currentPage > totalPages) {
      goToPage(totalPages);
    }
  }, [currentPage, goToPage, totalPages]);

  useEffect(() => {
    deploymentRef.current = initialDeploymentKind
      ? { deploymentKind: initialDeploymentKind, containerId: initialContainerId }
      : null;
  }, [connection.id, initialContainerId, initialDeploymentKind, logFilePath, sshConnectionId]);

  useEffect(() => {
    if (!active) return;
    const cached = slowLogCache.get(cacheKey);
    if (cached) {
      setText(cached.text);
      setFileSize(cached.fileSize);
      setPageLength(cached.pageLength);
      setCurrentPage(cached.page);
      loadedBytesRef.current = cached.pageLength;
      return;
    }
    setCurrentPage(1);
    void loadPage(1);
  }, [active, cacheKey, loadPage]);

  const textRef = useRef(text);
  textRef.current = text;
  const currentPageRef = useRef(currentPage);
  currentPageRef.current = currentPage;
  useEffect(() => {
    return () => {
      if (textRef.current) {
        slowLogCache.set(cacheKey, {
          text: textRef.current,
          fileSize: fileSizeRef.current ?? 0,
          pageLength: loadedBytesRef.current,
          page: currentPageRef.current,
        });
      }
    };
  }, [cacheKey]);

  const handleRefresh = useCallback(() => {
    slowLogCache.delete(cacheKey);
    setCurrentPage(1);
    if (listRef.current) {
      listRef.current.scrollTop = 0;
    }
    void loadPage(1);
  }, [cacheKey, loadPage]);

  const entries = useMemo(() => {
    const parsed = parseSlowQueryLog(text);
    return mergeConsecutiveEntries(parsed.reverse());
  }, [text]);

  const matchEntry = useMemo(() => compileSlowLogFilter(filters), [filters]);

  const filteredEntries = useMemo(() => {
    if (!hasActiveSlowLogFilters(filters)) return entries;
    return entries.filter((entry) => matchEntry(entry));
  }, [entries, filters, matchEntry]);

  const filtersActive = hasActiveSlowLogFilters(filters);

  const databaseSelectOptions = useMemo(
    () => databaseOptions.map((name) => ({ value: name, label: name })),
    [databaseOptions],
  );

  const tableSelectOptions = useMemo(
    () => tableOptions.map((name) => ({ value: name, label: name })),
    [tableOptions],
  );

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void listDatabases(connection)
      .then((names) => {
        if (cancelled) return;
        setDatabaseOptions(names.filter((name) => !SYSTEM_DB_SKIP.has(name.toLowerCase())));
      })
      .catch(() => {
        if (!cancelled) setDatabaseOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [active, connection]);

  useEffect(() => {
    if (!active) return;
    if (filters.databases.length === 0) {
      setTableOptions([]);
      setFilters((prev) => (prev.tables.length === 0 ? prev : { ...prev, tables: [] }));
      return;
    }
    let cancelled = false;
    void Promise.all(
      filters.databases.map(async (db) => {
        const tables = await listTables(connection, db);
        return tables.map((table) => `${db}.${table}`);
      }),
    )
      .then((groups) => {
        if (cancelled) return;
        const next = groups.flat();
        setTableOptions(next);
        setFilters((prev) => {
          const tables = prev.tables.filter((value) => next.includes(value));
          if (tables.length === prev.tables.length) return prev;
          return { ...prev, tables };
        });
      })
      .catch(() => {
        if (!cancelled) {
          setTableOptions([]);
          setFilters((prev) => (prev.tables.length === 0 ? prev : { ...prev, tables: [] }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [active, connection, filters.databases]);

  const handleClearFilters = useCallback(() => {
    setFilters(EMPTY_SLOW_LOG_FILTERS);
    if (listRef.current) {
      listRef.current.scrollTop = 0;
    }
  }, []);

  useEffect(() => {
    setSelectedIndex(0);
  }, [text]);

  const safeSelectedIndex =
    filteredEntries.length === 0 ? -1 : Math.min(selectedIndex, filteredEntries.length - 1);
  const selectedEntry = safeSelectedIndex >= 0 ? filteredEntries[safeSelectedIndex] : null;

  const listVirtualizer = useVirtualizer({
    count: filteredEntries.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => SLOW_LOG_ROW_HEIGHT,
    overscan: 16,
    useFlushSync: false,
  });

  const showInitialLoading = loading && filteredEntries.length === 0 && !filtersActive;
  const showFilterNoMatch =
    !loading && !error && filtersActive && filteredEntries.length === 0 && entries.length > 0;

  const footer = (
    <span className="db-slow-log-panel__meta">
      {fileSize !== null
        ? `${t("database.slowQueryLog.loadedBytes", {
            loaded: formatBytes(pageLength),
            total: formatBytes(fileSize),
          })} · `
        : ""}
      {logFilePath}
      {" · "}
      {filtersActive
        ? t("database.slowQueryLog.filterMatchCount", {
            matched: filteredEntries.length,
            total: entries.length,
          })
        : t("database.slowQueryLog.entryCount", { count: entries.length })}
    </span>
  );

  return (
    <div className="db-slow-log-panel">
      <div className="db-slow-log-panel__toolbar">
        <button
          type="button"
          className="log-viewer-panel__btn"
          disabled={loading}
          onClick={handleRefresh}
        >
          {t("common.refresh")}
        </button>
        <div className="db-slow-log-panel__pagination">
          <button
            type="button"
            className="log-viewer-panel__btn db-slow-log-panel__page-btn"
            disabled={loading || safePage <= 1}
            onClick={() => goToPage(1)}
            title={t("database.results.paginationFirst")}
            aria-label={t("database.results.paginationFirst")}
          >
            «
          </button>
          <button
            type="button"
            className="log-viewer-panel__btn db-slow-log-panel__page-btn"
            disabled={loading || safePage <= 1}
            onClick={() => goToPage(safePage - 1)}
            title={t("database.results.paginationPrev")}
            aria-label={t("database.results.paginationPrev")}
          >
            ‹
          </button>
          <span className="db-slow-log-panel__pagination-info">
            {t("database.slowQueryLog.pageIndicator", { page: safePage, total: totalPages })}
          </span>
          <button
            type="button"
            className="log-viewer-panel__btn db-slow-log-panel__page-btn"
            disabled={loading || safePage >= totalPages}
            onClick={() => goToPage(safePage + 1)}
            title={t("database.results.paginationNext")}
            aria-label={t("database.results.paginationNext")}
          >
            ›
          </button>
          <button
            type="button"
            className="log-viewer-panel__btn db-slow-log-panel__page-btn"
            disabled={loading || safePage >= totalPages}
            onClick={() => goToPage(totalPages)}
            title={t("database.results.paginationLast")}
            aria-label={t("database.results.paginationLast")}
          >
            »
          </button>
        </div>
      </div>
      <div className="db-slow-log-panel__filters">
          <label className="db-slow-log-panel__filter-field">
            <span className="db-slow-log-panel__filter-label">
              {t("database.slowQueryLog.filterDateFrom")}
            </span>
            <input
              type="datetime-local"
              step={1}
              className="db-slow-log-panel__filter-input db-slow-log-panel__filter-input--datetime"
              value={filters.dateFrom}
              onChange={(event) =>
                setFilters((prev) => ({ ...prev, dateFrom: event.target.value }))
              }
            />
          </label>
          <label className="db-slow-log-panel__filter-field">
            <span className="db-slow-log-panel__filter-label">
              {t("database.slowQueryLog.filterDateTo")}
            </span>
            <input
              type="datetime-local"
              step={1}
              className="db-slow-log-panel__filter-input db-slow-log-panel__filter-input--datetime"
              value={filters.dateTo}
              min={filters.dateFrom || undefined}
              onChange={(event) =>
                setFilters((prev) => ({ ...prev, dateTo: event.target.value }))
              }
            />
          </label>
          <label className="db-slow-log-panel__filter-field db-slow-log-panel__filter-field--narrow">
            <span className="db-slow-log-panel__filter-label">
              {t("database.slowQueryLog.filterMinQueryTime")}
            </span>
            <input
              type="number"
              min={0}
              step={0.001}
              className="db-slow-log-panel__filter-input db-slow-log-panel__filter-input--number"
              value={filters.minQueryTime}
              placeholder={t("database.slowQueryLog.filterMinQueryTimePlaceholder")}
              onChange={(event) =>
                setFilters((prev) => ({ ...prev, minQueryTime: event.target.value }))
              }
            />
          </label>
          <label className="db-slow-log-panel__filter-field db-slow-log-panel__filter-field--select">
            <span className="db-slow-log-panel__filter-label">
              {t("database.slowQueryLog.filterDatabase")}
            </span>
            <MultiSelect
              size="sm"
              className="db-slow-log-panel__multi"
              values={filters.databases}
              onChange={(databases) => setFilters((prev) => ({ ...prev, databases }))}
              options={databaseSelectOptions}
              emptyMeansAll={false}
              searchable
              panelMinWidth={240}
              searchPlaceholder={t("database.slowQueryLog.filterSearch")}
              placeholder={t("database.slowQueryLog.filterDatabaseAll")}
              formatDisplayLabel={(labels) =>
                labels.length === 0
                  ? t("database.slowQueryLog.filterDatabaseAll")
                  : labels.length <= 2
                    ? labels.join("、")
                    : t("database.slowQueryLog.filterSelectedCount", { count: labels.length })
              }
              aria-label={t("database.slowQueryLog.filterDatabase")}
            />
          </label>
          <label className="db-slow-log-panel__filter-field db-slow-log-panel__filter-field--select">
            <span className="db-slow-log-panel__filter-label">
              {t("database.slowQueryLog.filterTables")}
            </span>
            <MultiSelect
              size="sm"
              className="db-slow-log-panel__multi"
              values={filters.tables}
              onChange={(tables) => setFilters((prev) => ({ ...prev, tables }))}
              options={tableSelectOptions}
              emptyMeansAll={false}
              searchable
              panelMinWidth={260}
              searchPlaceholder={t("database.slowQueryLog.filterSearch")}
              disabled={filters.databases.length === 0}
              placeholder={
                filters.databases.length === 0
                  ? t("database.slowQueryLog.filterTablesNeedDb")
                  : t("database.slowQueryLog.filterTablesAll")
              }
              formatDisplayLabel={(labels) =>
                filters.databases.length === 0
                  ? t("database.slowQueryLog.filterTablesNeedDb")
                  : labels.length === 0
                    ? t("database.slowQueryLog.filterTablesAll")
                    : labels.length <= 2
                      ? labels.join("、")
                      : t("database.slowQueryLog.filterSelectedCount", { count: labels.length })
              }
              aria-label={t("database.slowQueryLog.filterTables")}
            />
          </label>
          <label className="db-slow-log-panel__filter-field db-slow-log-panel__filter-field--keyword">
            <span className="db-slow-log-panel__filter-label">
              {t("database.slowQueryLog.filterKeyword")}
            </span>
            <input
              className="db-slow-log-panel__filter-input"
              value={filters.keyword}
              placeholder={t("database.slowQueryLog.filterKeywordPlaceholder")}
              onChange={(event) =>
                setFilters((prev) => ({ ...prev, keyword: event.target.value }))
              }
            />
          </label>
          {filtersActive ? (
            <button
              type="button"
              className="log-viewer-panel__btn db-slow-log-panel__filter-clear"
              onClick={handleClearFilters}
            >
              {t("database.slowQueryLog.filterClear")}
            </button>
          ) : null}
      </div>

      <div className="db-slow-log-panel__cols">
        <span>{t("database.slowQueryLog.colTime")}</span>
        <span>{t("database.slowQueryLog.tagQuery")}</span>
        <span>{t("database.slowQueryLog.tagExamined")}</span>
        <span>{t("database.slowQueryLog.colSql")}</span>
      </div>
      <div className="db-slow-log-panel__list" ref={listRef}>
        {showInitialLoading ? (
          <div className="db-slow-log-panel__loading">{t("database.slowQueryLog.loading")}</div>
        ) : error ? (
          <div className="db-slow-log-panel__error">{error}</div>
        ) : showFilterNoMatch ? (
          <div className="db-slow-log-panel__empty">{t("database.slowQueryLog.filterNoMatch")}</div>
        ) : filteredEntries.length === 0 ? (
          <div className="db-slow-log-panel__empty">{t("database.slowQueryLog.empty")}</div>
        ) : (
          <div
            className="db-slow-log-panel__virtual"
            style={{ height: listVirtualizer.getTotalSize() }}
          >
            {listVirtualizer.getVirtualItems().map((item) => {
              const entry = filteredEntries[item.index];
              if (!entry) return null;
              const sqlPreview = entry.sql.replace(/\s+/g, " ").trim();
              return (
                <button
                  key={item.key}
                  type="button"
                  className={`db-slow-log-panel__row${item.index === safeSelectedIndex ? " is-selected" : ""}`}
                  style={{ transform: `translateY(${item.start}px)` }}
                  onClick={() => setSelectedIndex(item.index)}
                  title={sqlPreview}
                >
                  <span className="db-slow-log-panel__row-time">
                    {entry.time || "—"}
                    {entry.count > 1 ? ` · ${entry.count}x` : ""}
                  </span>
                  <span className="db-slow-log-panel__row-metric">{formatDuration(entry.queryTime)}</span>
                  <span className="db-slow-log-panel__row-metric">{entry.rowsExamined.toLocaleString()}</span>
                  <span className="db-slow-log-panel__row-sql">{sqlPreview}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      {selectedEntry ? (
        <SlowQueryDetail entry={selectedEntry} />
      ) : (
        <div className="db-slow-log-panel__detail db-slow-log-panel__detail--empty">
          {t("database.slowQueryLog.detailEmpty")}
        </div>
      )}

      <div className="db-slow-log-panel__footer">{footer}</div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
