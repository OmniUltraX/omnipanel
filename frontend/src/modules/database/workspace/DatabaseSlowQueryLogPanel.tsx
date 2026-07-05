import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../../i18n";
import type { DbConnectionConfig } from "../api";
import {
  readMysqlSlowLogFileSize,
  readMysqlSlowLogTail,
} from "../mysqlSlowQueryLog";
import { useDbDockTabActive } from "../useDbDockTabActive";

const SLOW_LOG_CHUNK = 16 * 1024;
const SLOW_LOG_MAX_CHUNKS = 100;
const SLOW_LOG_MAX_BYTES = SLOW_LOG_CHUNK * SLOW_LOG_MAX_CHUNKS;

interface SlowLogCacheValue {
  text: string;
  fileSize: number;
  loadedBytes: number;
}
const slowLogCache = new Map<string, SlowLogCacheValue>();

// ---- Types ----

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

// ---- Parser ----

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
  "ORDERED", "DESC", "ASC", "FETCH", "NEXT", "ROWS", "ONLY",
  "WITH", "RECURSIVE", "EXPLAIN", "ANALYZE", "SHOW", "USE",
  "DESCRIBE", "CASCADE", "RESTRICT", "SERIALIZABLE", "COMMITTED",
  "READ", "WRITE", "REPEATABLE", "SNAPSHOT", "ISOLATION", "LEVEL",
  "MATERIALIZED", "TEMP", "TEMPORARY", "SCHEMA", "DATABASE",
  "TRUNCATE", "REPLACE", "MERGE", "DO", "RETURNING", "CONFLICT",
  "EXCEPT", "INTERSECT", "LEFT", "RIGHT", "INNER", "OUTER", "FULL",
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

/** 合并连续相同 SQL 的条目。 */
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

// ---- SlowQueryCard ----

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
        {entry.count > 1 && (
          <span className="slow-query-card__count-badge">{entry.count}x</span>
        )}
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
        <span className="slow-query-card__analyze" title="分析">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
            <path d="M2 14V5l4-3 4 3v9" />
            <path d="M2 9h8" />
            <circle cx="10" cy="5" r="1.5" />
          </svg>
        </span>
      </div>
    </div>
  );
}

// ---- Panel ----

interface DatabaseSlowQueryLogPanelProps {
  connection: DbConnectionConfig;
  sshConnectionId: string;
  logFilePath: string;
  deploymentKind?: "host" | "docker";
  containerId?: string;
  tabId: string;
}

export function DatabaseSlowQueryLogPanel({
  connection: _connection,
  sshConnectionId,
  logFilePath,
  deploymentKind,
  containerId,
  tabId,
}: DatabaseSlowQueryLogPanelProps) {
  const active = useDbDockTabActive(tabId);
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileSize, setFileSize] = useState<number | null>(null);
  const [loadedBytes, setLoadedBytes] = useState(0);
  const loadedBytesRef = useRef(0);
  const loadingRef = useRef(false);
  const scrollRestoreRef = useRef<{ scrollTop: number; scrollHeight: number } | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const cacheKey = `${sshConnectionId}::${logFilePath}`;

  const loadTail = useCallback(
    async (bytesFromEnd: number, options?: { resetScroll?: boolean }) => {
      if (loadingRef.current) return;
      const el = bodyRef.current;
      const previousLoadedBytes = loadedBytesRef.current;
      const isLoadMore = previousLoadedBytes > 0 && bytesFromEnd > previousLoadedBytes;
      if (isLoadMore && el && !options?.resetScroll) {
        scrollRestoreRef.current = {
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
        };
      } else {
        scrollRestoreRef.current = null;
      }

      loadingRef.current = true;
      setLoading(true);
      setError(null);
      try {
        const [size, chunk] = await Promise.all([
          readMysqlSlowLogFileSize(sshConnectionId, logFilePath, deploymentKind, containerId),
          readMysqlSlowLogTail(sshConnectionId, logFilePath, bytesFromEnd, deploymentKind, containerId),
        ]);
        setFileSize(size);
        setText(chunk);
        const loaded = Math.min(bytesFromEnd, size);
        loadedBytesRef.current = loaded;
        setLoadedBytes(loaded);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
        loadingRef.current = false;
      }
    },
    [logFilePath, sshConnectionId, deploymentKind, containerId],
  );

  // 挂载：优先使用缓存
  useEffect(() => {
    if (!active) return;
    const cached = slowLogCache.get(cacheKey);
    if (cached) {
      setText(cached.text);
      setFileSize(cached.fileSize);
      setLoadedBytes(cached.loadedBytes);
      loadedBytesRef.current = cached.loadedBytes;
      return;
    }
    void loadTail(SLOW_LOG_CHUNK);
  }, [active, cacheKey, loadTail]);

  // 卸载：保存到缓存
  const textRef = useRef(text);
  textRef.current = text;
  const fileSizeRef = useRef(fileSize);
  fileSizeRef.current = fileSize;
  useEffect(() => {
    return () => {
      if (textRef.current) {
        slowLogCache.set(cacheKey, {
          text: textRef.current,
          fileSize: fileSizeRef.current ?? 0,
          loadedBytes: loadedBytesRef.current,
        });
      }
    };
  }, [cacheKey]);

  // 刷新：清除缓存并重新加载初始块
  const handleRefresh = useCallback(() => {
    slowLogCache.delete(cacheKey);
    scrollRestoreRef.current = null;
    if (bodyRef.current) {
      bodyRef.current.scrollTop = 0;
    }
    void loadTail(SLOW_LOG_CHUNK, { resetScroll: true });
  }, [cacheKey, loadTail]);

  // 无限滚动加载
  const canLoadMore = fileSize !== null && loadedBytes < fileSize && loadedBytes < SLOW_LOG_MAX_BYTES;

  const handleScroll = useCallback(() => {
    const el = bodyRef.current;
    if (!el || loadingRef.current || !canLoadMore) return;
    const threshold = 150;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < threshold) {
      const next = Math.min(
        fileSize ?? loadedBytesRef.current + SLOW_LOG_CHUNK,
        loadedBytesRef.current + SLOW_LOG_CHUNK,
        SLOW_LOG_MAX_BYTES,
      );
      if (next > loadedBytesRef.current) {
        void loadTail(next);
      }
    }
  }, [canLoadMore, fileSize, loadTail]);

  const entries = useMemo(() => {
    const parsed = parseSlowQueryLog(text);
    return mergeConsecutiveEntries(parsed.reverse());
  }, [text]);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    const anchor = scrollRestoreRef.current;
    if (!el || !anchor) return;
    scrollRestoreRef.current = null;
    el.scrollTop = anchor.scrollTop;
  }, [text, entries.length]);

  const showInitialLoading = loading && entries.length === 0;
  const showLoadMoreLoading = loading && entries.length > 0;

  const footer = (
    <span className="db-slow-log-panel__meta">
      {fileSize !== null
        ? t("database.slowQueryLog.loadedBytes", {
            loaded: formatBytes(loadedBytes),
            total: formatBytes(fileSize),
          }) + " · "
        : ""}
      {logFilePath}
      {" · "}
      {t("database.slowQueryLog.entryCount", { count: entries.length })}
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
        <span className="db-slow-log-panel__stats">
          {entries.length > 0 && `共 ${entries.length} 条慢查询`}
        </span>
      </div>

      <div
        className="db-slow-log-panel__body"
        ref={bodyRef}
        onScroll={handleScroll}
      >
        <div className="db-slow-log-panel__list">
          {showInitialLoading && (
            <div className="db-slow-log-panel__loading">{t("database.slowQueryLog.loading")}</div>
          )}
          {error && <div className="db-slow-log-panel__error">{error}</div>}
          {!showInitialLoading && !error && entries.length === 0 && (
            <div className="db-slow-log-panel__empty">{t("database.slowQueryLog.empty")}</div>
          )}
          {entries.map((entry, idx) => (
            <SlowQueryCard key={`${entry.time}:${entry.sql.slice(0, 48)}:${idx}`} entry={entry} />
          ))}
          {showLoadMoreLoading && (
            <div className="db-slow-log-panel__loading db-slow-log-panel__loading--more">
              {t("database.slowQueryLog.loading")}
            </div>
          )}
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
