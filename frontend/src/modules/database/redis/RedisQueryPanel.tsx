import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useI18n } from "../../../i18n";
import { Button } from "../../../components/ui/primitives/Button";
import { Select } from "../../../components/ui/form/Select";
import { TextInput } from "../../../components/ui/form/TextInput";
import {
  isRedisConnection,
  listDatabases,
  redisSearchKeys,
  type DbConnectionConfig,
  type RedisKeyEntry,
} from "../api";
import { connectionWithDatabase } from "../toolbox/types";
import { TableDataGrid } from "../grid/TableDataGrid";

const REDIS_KEY_TYPES = ["string", "list", "set", "zset", "hash", "stream"] as const;

const RESULT_COLUMNS = ["key", "type", "value"] as const;

/** 单次 SCAN 请求拉取的匹配键数量 */
const REDIS_SEARCH_FETCH_LIMIT = 100;

const SCROLL_LOAD_THRESHOLD_PX = 64;

interface RedisQueryPanelProps {
  connection: DbConnectionConfig;
  /** 从侧栏点选具体库时锁定；点连接时为空则显示库下拉 */
  fixedDbName?: string;
}

function resolveInitialDb(fixedDbName: string | undefined, connection: DbConnectionConfig): string {
  if (fixedDbName) {
    return fixedDbName;
  }
  if (connection.database) {
    return connection.database;
  }
  return "0";
}

function isBroadPattern(pattern: string): boolean {
  const trimmed = pattern.trim();
  return trimmed === "" || trimmed === "*";
}

function entryToRow(entry: RedisKeyEntry, showValuePreview: boolean): Record<string, unknown> {
  return {
    key: entry.key,
    type: entry.keyType,
    value: showValuePreview ? entry.value : "—",
  };
}

function getResultsScrollWrap(): HTMLElement | null {
  const wrap = document.querySelector(".redis-query-results .db-data-table-wrap");
  return wrap instanceof HTMLElement ? wrap : null;
}

function isScrollNearBottom(wrap: HTMLElement, threshold = SCROLL_LOAD_THRESHOLD_PX): boolean {
  return wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight <= threshold;
}

export function RedisQueryPanel({ connection, fixedDbName }: RedisQueryPanelProps) {
  const { t } = useI18n();
  const capable = isRedisConnection(connection);

  const [databases, setDatabases] = useState<string[]>([]);
  const [selectedDb, setSelectedDb] = useState(() => resolveInitialDb(fixedDbName, connection));
  const [pattern, setPattern] = useState("");
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(
    () => new Set(REDIS_KEY_TYPES),
  );
  const [includeValuePreview, setIncludeValuePreview] = useState(false);
  const [searching, setSearching] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingDbs, setLoadingDbs] = useState(!fixedDbName);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<RedisKeyEntry[]>([]);
  const [scanCursor, setScanCursor] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [scanLimitHit, setScanLimitHit] = useState(false);

  const searchRequestIdRef = useRef(0);
  const hasMoreRef = useRef(hasMore);
  const loadingMoreRef = useRef(loadingMore);
  const searchingRef = useRef(searching);
  const scanCursorRef = useRef(scanCursor);

  hasMoreRef.current = hasMore;
  loadingMoreRef.current = loadingMore;
  searchingRef.current = searching;
  scanCursorRef.current = scanCursor;

  const activeDb = fixedDbName ?? selectedDb;
  const broadPattern = isBroadPattern(pattern);
  const hasResults = entries.length > 0;
  const busy = searching || loadingMore;

  const scopedConnection = useMemo(
    () => connectionWithDatabase(connection, activeDb),
    [connection, activeDb],
  );

  useEffect(() => {
    if (fixedDbName) {
      setSelectedDb(fixedDbName);
      return;
    }
    let cancelled = false;
    setLoadingDbs(true);
    void listDatabases(connection)
      .then((names) => {
        if (cancelled) return;
        setDatabases(names);
        if (names.length > 0) {
          setSelectedDb((prev) => (names.includes(prev) ? prev : names[0]!));
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setError(typeof e === "string" ? e : JSON.stringify(e));
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingDbs(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [connection.id, fixedDbName, connection]);

  const toggleType = useCallback((type: string) => {
    setSelectedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  }, []);

  const fetchKeys = useCallback(
    async (options: { cursor: number; append: boolean }) => {
      if (!capable) {
        return;
      }

      const requestId = options.append ? searchRequestIdRef.current : ++searchRequestIdRef.current;

      if (options.append) {
        setLoadingMore(true);
      } else {
        setSearching(true);
        setError(null);
      }

      try {
        const result = await redisSearchKeys({
          connection: scopedConnection,
          pattern,
          types: [...selectedTypes],
          limit: REDIS_SEARCH_FETCH_LIMIT,
          cursor: options.cursor,
          includeValuePreview,
        });

        if (!options.append && requestId !== searchRequestIdRef.current) {
          return;
        }

        const batch = result.entries ?? [];
        setEntries((prev) => (options.append ? [...prev, ...batch] : batch));
        setScanCursor(result.nextCursor);
        setHasMore(result.hasMore);
        setScanLimitHit(Boolean(result.scanLimitHit));
      } catch (e) {
        if (!options.append && requestId !== searchRequestIdRef.current) {
          return;
        }
        if (!options.append) {
          setEntries([]);
          setScanCursor(0);
          setHasMore(false);
          setScanLimitHit(false);
        }
        setError(typeof e === "string" ? e : JSON.stringify(e));
      } finally {
        if (options.append) {
          setLoadingMore(false);
        } else if (requestId === searchRequestIdRef.current) {
          setSearching(false);
        }
      }
    },
    [capable, scopedConnection, pattern, selectedTypes, includeValuePreview],
  );

  const loadMore = useCallback(() => {
    if (!hasMoreRef.current || searchingRef.current || loadingMoreRef.current) {
      return;
    }
    void fetchKeys({ cursor: scanCursorRef.current, append: true });
  }, [fetchKeys]);

  const tryFillViewport = useCallback(() => {
    if (!hasMoreRef.current || searchingRef.current || loadingMoreRef.current) {
      return;
    }
    const wrap = getResultsScrollWrap();
    if (!wrap) {
      return;
    }
    if (isScrollNearBottom(wrap)) {
      loadMore();
    }
  }, [loadMore]);

  const runSearch = useCallback(() => {
    void fetchKeys({ cursor: 0, append: false });
  }, [fetchKeys]);

  const handleNearScrollBottom = useCallback(() => {
    loadMore();
  }, [loadMore]);

  useEffect(() => {
    if (!hasResults || !hasMore || searching || loadingMore) {
      return;
    }
    const raf = requestAnimationFrame(() => {
      tryFillViewport();
    });
    return () => cancelAnimationFrame(raf);
  }, [hasResults, hasMore, searching, loadingMore, entries.length, tryFillViewport]);

  useEffect(() => {
    if (!hasResults || !hasMore) {
      return;
    }
    const wrap = getResultsScrollWrap();
    if (!wrap) {
      return;
    }
    const onScroll = () => {
      if (isScrollNearBottom(wrap)) {
        handleNearScrollBottom();
      }
    };
    wrap.addEventListener("scroll", onScroll, { passive: true });
    return () => wrap.removeEventListener("scroll", onScroll);
  }, [hasResults, hasMore, handleNearScrollBottom, entries.length]);

  const handleSearchKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void runSearch();
      }
    },
    [runSearch],
  );

  const gridRows = useMemo(
    () => entries.map((entry) => entryToRow(entry, includeValuePreview)),
    [entries, includeValuePreview],
  );

  if (!capable) {
    return (
      <div className="redis-query-panel">
        <div className="db-table-designer-state">
          {t("database.redisQuery.unsupportedEngine", { engine: connection.db_type })}
        </div>
      </div>
    );
  }

  return (
    <div className="redis-query-panel">
      <div className="redis-query-toolbar">
        {!fixedDbName ? (
          <Select
            className="redis-query-db-select"
            value={selectedDb}
            onChange={(value) => setSelectedDb(value)}
            disabled={loadingDbs || busy}
            searchable
            options={databases.map((name) => ({ value: name, label: `DB ${name}` }))}
            placeholder={t("database.redisQuery.database")}
          />
        ) : null}
        <TextInput
          copyable={false}
          className="redis-query-search-input"
          value={pattern}
          onChange={setPattern}
          onKeyDown={handleSearchKeyDown}
          placeholder={t("database.redisQuery.patternPlaceholder")}
          disabled={busy}
          spellCheck={false}
          aria-label={t("database.redisQuery.pattern")}
        />
        <Button
          variant="primary"
          size="sm"
          onClick={() => void runSearch()}
          disabled={busy || loadingDbs || selectedTypes.size === 0}
        >
          {searching ? t("database.redisQuery.searching") : t("database.redisQuery.search")}
        </Button>
      </div>

      <div className="redis-query-type-filters">
        <span className="redis-query-type-label">{t("database.redisQuery.types")}</span>
        {REDIS_KEY_TYPES.map((type) => (
          <label key={type} className="redis-query-type-option">
            <input
              type="checkbox"
              checked={selectedTypes.has(type)}
              onChange={() => toggleType(type)}
              disabled={busy}
            />
            <span>{type}</span>
          </label>
        ))}
        <label className="redis-query-type-option redis-query-preview-option">
          <input
            type="checkbox"
            checked={includeValuePreview}
            onChange={(e) => setIncludeValuePreview(e.target.checked)}
            disabled={busy}
          />
          <span>{t("database.redisQuery.valuePreview")}</span>
        </label>
      </div>

      {broadPattern ? (
        <div className="redis-query-hint db-exec-stats-truncated">
          {t("database.redisQuery.broadPatternHint")}
        </div>
      ) : null}

      <div className="redis-query-results">
        {error ? (
          <div className="db-table-designer-state db-table-designer-state--error">{error}</div>
        ) : searching && !hasResults ? (
          <div className="db-table-designer-state">{t("common.loading")}</div>
        ) : hasResults ? (
          <div className="redis-query-results-body">
            {scanLimitHit ? (
              <div className="redis-query-truncated db-exec-stats-truncated">
                {t("database.redisQuery.scanLimitHit")}
              </div>
            ) : null}
            {searching ? (
              <div className="redis-query-results-overlay">{t("common.loading")}</div>
            ) : null}
            <TableDataGrid
              columns={[...RESULT_COLUMNS]}
              rows={gridRows}
              totalRows={entries.length}
              page={0}
              pageSize={Math.max(entries.length, 1)}
              loading={false}
              onPageChange={() => {}}
              footerExtra={
                loadingMore ? (
                  <span className="redis-query-scroll-loading">{t("database.redisQuery.loadingMore")}</span>
                ) : null
              }
            />
          </div>
        ) : (
          <div className="db-table-designer-state">{t("database.redisQuery.empty")}</div>
        )}
      </div>
    </div>
  );
}
