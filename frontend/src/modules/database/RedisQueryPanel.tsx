import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { useI18n } from "../../i18n";
import { Button } from "../../components/ui/Button";
import { Select } from "../../components/ui/Select";
import { TextInput } from "../../components/ui/TextInput";
import {
  isRedisConnection,
  listDatabases,
  redisSearchKeys,
  type DbConnectionConfig,
  type RedisKeyEntry,
} from "./api";
import { connectionWithDatabase } from "./toolbox/types";
import { TableDataGrid } from "./TableDataGrid";

const REDIS_KEY_TYPES = ["string", "list", "set", "zset", "hash", "stream"] as const;

const RESULT_COLUMNS = ["key", "type", "value"] as const;

/** 表格每页展示行数（仅渲染当前页，避免大量 DOM 卡死） */
const REDIS_QUERY_PAGE_SIZE = 100;

/** 单次从 Redis 拉取的最大键数量（后端 SCAN 上限 2000） */
const REDIS_SEARCH_FETCH_LIMIT = 500;

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

function entryToRow(entry: RedisKeyEntry): Record<string, unknown> {
  return {
    key: entry.key,
    type: entry.keyType,
    value: entry.value,
  };
}

export function RedisQueryPanel({ connection, fixedDbName }: RedisQueryPanelProps) {
  const { t } = useI18n();
  const capable = isRedisConnection(connection);

  const [databases, setDatabases] = useState<string[]>([]);
  const [selectedDb, setSelectedDb] = useState(() => resolveInitialDb(fixedDbName, connection));
  const [pattern, setPattern] = useState("*");
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(
    () => new Set(REDIS_KEY_TYPES),
  );
  const [loading, setLoading] = useState(false);
  const [loadingDbs, setLoadingDbs] = useState(!fixedDbName);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<RedisKeyEntry[]>([]);
  const [page, setPage] = useState(0);
  const [hitFetchLimit, setHitFetchLimit] = useState(false);

  const activeDb = fixedDbName ?? selectedDb;

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

  const runSearch = useCallback(async () => {
    if (!capable) {
      return;
    }
    setLoading(true);
    setError(null);
    setPage(0);
    try {
      const result = await redisSearchKeys({
        connection: scopedConnection,
        pattern,
        types: [...selectedTypes],
        limit: REDIS_SEARCH_FETCH_LIMIT,
      });
      setEntries(result);
      setHitFetchLimit(result.length >= REDIS_SEARCH_FETCH_LIMIT);
    } catch (e) {
      setEntries([]);
      setHitFetchLimit(false);
      setError(typeof e === "string" ? e : JSON.stringify(e));
    } finally {
      setLoading(false);
    }
  }, [capable, scopedConnection, pattern, selectedTypes]);

  const handleSearchKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void runSearch();
      }
    },
    [runSearch],
  );

  const pagedRows = useMemo(() => {
    const start = page * REDIS_QUERY_PAGE_SIZE;
    return entries.slice(start, start + REDIS_QUERY_PAGE_SIZE).map(entryToRow);
  }, [entries, page]);

  const handlePageChange = useCallback((nextPage: number) => {
    setPage(nextPage);
  }, []);

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
            disabled={loadingDbs || loading}
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
          disabled={loading}
          spellCheck={false}
          aria-label={t("database.redisQuery.pattern")}
        />
        <Button
          variant="primary"
          size="sm"
          onClick={() => void runSearch()}
          disabled={loading || loadingDbs || selectedTypes.size === 0}
        >
          {loading ? t("database.redisQuery.searching") : t("database.redisQuery.search")}
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
              disabled={loading}
            />
            <span>{type}</span>
          </label>
        ))}
      </div>

      <div className="redis-query-results">
        {error ? (
          <div className="db-table-designer-state db-table-designer-state--error">{error}</div>
        ) : loading ? (
          <div className="db-table-designer-state">{t("common.loading")}</div>
        ) : entries.length > 0 ? (
          <>
            {hitFetchLimit ? (
              <div className="redis-query-truncated db-exec-stats-truncated">
                {t("database.redisQuery.truncated", { limit: REDIS_SEARCH_FETCH_LIMIT })}
              </div>
            ) : null}
            <TableDataGrid
              columns={[...RESULT_COLUMNS]}
              rows={pagedRows}
              totalRows={entries.length}
              page={page}
              pageSize={REDIS_QUERY_PAGE_SIZE}
              loading={false}
              onPageChange={handlePageChange}
            />
          </>
        ) : (
          <div className="db-table-designer-state">{t("database.redisQuery.empty")}</div>
        )}
      </div>
    </div>
  );
}
