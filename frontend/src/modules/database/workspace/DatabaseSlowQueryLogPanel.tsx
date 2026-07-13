import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../../i18n";
import { useConnectionStore } from "../../../stores/connectionStore";
import type { DbConnectionConfig } from "../api";
import {
  probeSlowLogAvailability,
  readMysqlSlowLogFileSize,
  readMysqlSlowLogRange,
  slowLogPageByteRange,
  slowLogTotalPages,
} from "../mysqlSlowQueryLog";

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

interface SlowLogFilters {
  dateFrom: string;
  dateTo: string;
  minQueryTime: string;
}

const EMPTY_FILTERS: SlowLogFilters = { dateFrom: "", dateTo: "", minQueryTime: "" };

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

function highlightSql(sql: string): string {
  let escaped = sql
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
  return escaped;
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

/** 朴素日期时间（不做时区换算，按日志/表单上可见的时钟时间比较）。 */
interface NaiveDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function parseNaiveDateTime(value: string): NaiveDateTime | null {
  const s = value.trim();
  if (!s) return null;

  // datetime-local：2024-06-15T08:09 或 2024-06-15T08:09:10
  const local = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (local) {
    return {
      year: Number.parseInt(local[1], 10),
      month: Number.parseInt(local[2], 10),
      day: Number.parseInt(local[3], 10),
      hour: Number.parseInt(local[4], 10),
      minute: Number.parseInt(local[5], 10),
      second: local[6] ? Number.parseInt(local[6], 10) : 0,
    };
  }

  // MySQL ISO：2024-06-15T08:09:10.123456Z / +08:00（忽略时区后缀，按字面时钟比较）
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
  if (iso) {
    return {
      year: Number.parseInt(iso[1], 10),
      month: Number.parseInt(iso[2], 10),
      day: Number.parseInt(iso[3], 10),
      hour: Number.parseInt(iso[4], 10),
      minute: Number.parseInt(iso[5], 10),
      second: Number.parseInt(iso[6], 10),
    };
  }

  // 传统格式：YYMMDD HH:MM:SS
  const legacy = s.match(/^(\d{2})(\d{2})(\d{2})\s+(\d{1,2}):(\d{2}):(\d{2})/);
  if (legacy) {
    return {
      year: 2000 + Number.parseInt(legacy[1], 10),
      month: Number.parseInt(legacy[2], 10),
      day: Number.parseInt(legacy[3], 10),
      hour: Number.parseInt(legacy[4], 10),
      minute: Number.parseInt(legacy[5], 10),
      second: Number.parseInt(legacy[6], 10),
    };
  }

  return null;
}

function compareNaiveDateTime(a: NaiveDateTime, b: NaiveDateTime): number {
  if (a.year !== b.year) return a.year - b.year;
  if (a.month !== b.month) return a.month - b.month;
  if (a.day !== b.day) return a.day - b.day;
  if (a.hour !== b.hour) return a.hour - b.hour;
  if (a.minute !== b.minute) return a.minute - b.minute;
  return a.second - b.second;
}

function hasActiveFilters(filters: SlowLogFilters): boolean {
  return Boolean(filters.dateFrom || filters.dateTo || filters.minQueryTime.trim());
}

function matchesSlowLogFilters(entry: SlowQueryEntry, filters: SlowLogFilters): boolean {
  if (filters.minQueryTime.trim()) {
    const minSeconds = Number.parseFloat(filters.minQueryTime);
    if (Number.isFinite(minSeconds) && entry.queryTime <= minSeconds) {
      return false;
    }
  }

  if (filters.dateFrom || filters.dateTo) {
    const timestamp = parseNaiveDateTime(entry.time);
    if (!timestamp) return false;
    if (filters.dateFrom) {
      const from = parseNaiveDateTime(filters.dateFrom);
      if (from && compareNaiveDateTime(timestamp, from) < 0) return false;
    }
    if (filters.dateTo) {
      const to = parseNaiveDateTime(filters.dateTo);
      if (to && compareNaiveDateTime(timestamp, to) > 0) return false;
    }
  }

  return true;
}

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

function SlowQueryCard({ entry }: { entry: SlowQueryEntry }) {
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
    <div className="slow-query-card">
      <div className="slow-query-card__header">
        <div className="slow-query-card__time">{entry.time}</div>
        {entry.count > 1 ? (
          <span className="slow-query-card__count-badge">{entry.count}x</span>
        ) : null}
        <div className="slow-query-card__user">{entry.userHost}</div>
      </div>

      <div className="slow-query-card__sql">
        <button
          type="button"
          className="slow-query-card__copy-btn"
          onClick={handleCopy}
          title={t("database.slowQueryLog.copy")}
        >
          {copied ? t("database.slowQueryLog.copied") : t("database.slowQueryLog.copy")}
        </button>
        <pre className="slow-query-card__sql-text" dangerouslySetInnerHTML={{ __html: highlighted }} />
      </div>

      <div className="slow-query-card__tags">
        <span className="slow-query-card__tag slow-query-card__tag--danger">
          {t("database.slowQueryLog.tagQuery")}: {formatDuration(entry.queryTime)}
        </span>
        <span className="slow-query-card__tag slow-query-card__tag--warn">
          {t("database.slowQueryLog.tagLock")}: {formatDuration(entry.lockTime)}
        </span>
        <span className="slow-query-card__tag slow-query-card__tag--success">
          {t("database.slowQueryLog.tagSent")}: {entry.rowsSent.toLocaleString()}
        </span>
        <span className="slow-query-card__tag">
          {t("database.slowQueryLog.tagExamined")}: {entry.rowsExamined.toLocaleString()}
        </span>
      </div>
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
  const [draftFilters, setDraftFilters] = useState<SlowLogFilters>(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<SlowLogFilters>(EMPTY_FILTERS);
  const loadedBytesRef = useRef(0);
  const loadingRef = useRef(false);
  const bodyRef = useRef<HTMLDivElement>(null);
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
        const size = await readMysqlSlowLogFileSize(
          sshConnectionId,
          logFilePath,
          deployment.deploymentKind,
          deployment.containerId,
        );
        setFileSize(size);

        const safePage = Math.max(1, Math.min(page, slowLogTotalPages(size)));
        const { start, length } = slowLogPageByteRange(safePage, size);
        const raw = length > 0
          ? await readMysqlSlowLogRange(
              sshConnectionId,
              logFilePath,
              start,
              length,
              deployment.deploymentKind,
              deployment.containerId,
            )
          : "";
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
      if (bodyRef.current) {
        bodyRef.current.scrollTop = 0;
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
  const fileSizeRef = useRef(fileSize);
  fileSizeRef.current = fileSize;
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
    if (bodyRef.current) {
      bodyRef.current.scrollTop = 0;
    }
    void loadPage(1);
  }, [cacheKey, loadPage]);

  const entries = useMemo(() => {
    const parsed = parseSlowQueryLog(text);
    return mergeConsecutiveEntries(parsed.reverse());
  }, [text]);

  const filteredEntries = useMemo(() => {
    if (!hasActiveFilters(appliedFilters)) return entries;
    return entries.filter((entry) => matchesSlowLogFilters(entry, appliedFilters));
  }, [appliedFilters, entries]);

  const filtersActive = hasActiveFilters(appliedFilters);

  const handleApplyFilters = useCallback(() => {
    setAppliedFilters({ ...draftFilters });
    if (bodyRef.current) {
      bodyRef.current.scrollTop = 0;
    }
  }, [draftFilters]);

  const handleClearFilters = useCallback(() => {
    setDraftFilters(EMPTY_FILTERS);
    setAppliedFilters(EMPTY_FILTERS);
    if (bodyRef.current) {
      bodyRef.current.scrollTop = 0;
    }
  }, []);

  const showInitialLoading = loading && filteredEntries.length === 0 && !filtersActive;
  const showPageLoading = loading && (filteredEntries.length > 0 || filtersActive);
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
        <div className="db-slow-log-panel__filters">
          <label className="db-slow-log-panel__filter-field">
            <span className="db-slow-log-panel__filter-label">
              {t("database.slowQueryLog.filterDateFrom")}
            </span>
            <input
              type="datetime-local"
              step={1}
              className="db-slow-log-panel__filter-input db-slow-log-panel__filter-input--datetime"
              value={draftFilters.dateFrom}
              onChange={(event) =>
                setDraftFilters((prev) => ({ ...prev, dateFrom: event.target.value }))
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
              value={draftFilters.dateTo}
              min={draftFilters.dateFrom || undefined}
              onChange={(event) =>
                setDraftFilters((prev) => ({ ...prev, dateTo: event.target.value }))
              }
            />
          </label>
          <label className="db-slow-log-panel__filter-field">
            <span className="db-slow-log-panel__filter-label">
              {t("database.slowQueryLog.filterMinQueryTime")}
            </span>
            <input
              type="number"
              min={0}
              step={0.001}
              className="db-slow-log-panel__filter-input db-slow-log-panel__filter-input--number"
              value={draftFilters.minQueryTime}
              placeholder={t("database.slowQueryLog.filterMinQueryTimePlaceholder")}
              onChange={(event) =>
                setDraftFilters((prev) => ({ ...prev, minQueryTime: event.target.value }))
              }
              onKeyDown={(event) => {
                if (event.key === "Enter") handleApplyFilters();
              }}
            />
          </label>
          <button
            type="button"
            className="log-viewer-panel__btn"
            disabled={loading}
            onClick={handleApplyFilters}
          >
            {t("database.filter.apply")}
          </button>
          {filtersActive ? (
            <button
              type="button"
              className="log-viewer-panel__btn"
              disabled={loading}
              onClick={handleClearFilters}
            >
              {t("database.slowQueryLog.filterClear")}
            </button>
          ) : null}
        </div>
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

      <div className="db-slow-log-panel__body" ref={bodyRef}>
        <div className="db-slow-log-panel__list">
          {showInitialLoading ? (
            <div className="db-slow-log-panel__loading">{t("database.slowQueryLog.loading")}</div>
          ) : null}
          {error ? <div className="db-slow-log-panel__error">{error}</div> : null}
          {!showInitialLoading && !error && !filtersActive && entries.length === 0 ? (
            <div className="db-slow-log-panel__empty">{t("database.slowQueryLog.empty")}</div>
          ) : null}
          {showFilterNoMatch ? (
            <div className="db-slow-log-panel__empty">{t("database.slowQueryLog.filterNoMatch")}</div>
          ) : null}
          {filteredEntries.map((entry, idx) => (
            <SlowQueryCard key={`${entry.time}:${entry.sql.slice(0, 48)}:${idx}`} entry={entry} />
          ))}
          {showPageLoading ? (
            <div className="db-slow-log-panel__loading db-slow-log-panel__loading--more">
              {t("database.slowQueryLog.loading")}
            </div>
          ) : null}
        </div>
      </div>

      <div className="db-slow-log-panel__footer">{footer}</div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
