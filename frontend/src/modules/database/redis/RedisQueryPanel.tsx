import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { useI18n } from "../../../i18n";
import { Button } from "../../../components/ui/primitives/Button";
import { TextInput } from "../../../components/ui/form/TextInput";
import { useConnectionStore } from "../../../stores/connectionStore";
import {
  isRedisConnection,
  redisDbsize,
  redisSearchKeys,
  redisSetKey,
  type DbConnectionConfig,
  type RedisKeyEntry,
} from "../api";
import { connectionWithDatabase } from "../toolbox/types";
import {
  buildRedisPrefixTree,
  buildScanPattern,
  filterEntriesBySearchScope,
} from "./redisPrefixTree";
import {
  flattenRedisEntries,
  flattenRedisPrefixTree,
} from "./redisKeyBrowserRows";
import { RedisKeyBrowserList } from "./RedisKeyBrowserList";
import { RedisKeyDetailPanel } from "./RedisKeyDetailPanel";
import { RedisSlowLogPanel } from "./RedisSlowLogPanel";
import { ConnectionCliTabPanel } from "../workspace/ConnectionCliTabPanel";
import {
  isRedisDeploymentCacheUsable,
  readRedisDeploymentCache,
  writeRedisDeploymentCache,
} from "../redisDeploymentCache";
import { probeRedisDeployment, type RedisDeploymentInfo } from "../redisDeploymentDetect";
import { RedisPubSubPanel } from "../../protocol/RedisPubSubPanel";

const SCAN_BATCH_LIMIT = 1000;
const FETCH_ALL_HARD_LIMIT = 10000;
const ALL_KEY_TYPES = ["string", "list", "set", "zset", "hash", "stream"] as const;

type SearchScope = "key" | "value" | "all";
type ViewMode = "tree" | "flat";
type RightTab = "detail" | "cli" | "pubsub" | "slowlog";

interface RedisQueryPanelProps {
  connection: DbConnectionConfig;
  fixedDbName?: string;
}

export function RedisQueryPanel({ connection, fixedDbName }: RedisQueryPanelProps) {
  const { t } = useI18n();
  const capable = isRedisConnection(connection);
  const activeDb = fixedDbName ?? (connection.database?.trim() || "0");

  const sshConnections = useConnectionStore(
    useShallow((state) => state.connections.filter((conn) => conn.kind === "ssh")),
  );

  const [searchScope, setSearchScope] = useState<SearchScope>("key");
  const [keyword, setKeyword] = useState("");
  const [fuzzy, setFuzzy] = useState(true);
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(
    () => new Set(ALL_KEY_TYPES),
  );
  const [viewMode, setViewMode] = useState<ViewMode>("tree");
  const [autoLoad, setAutoLoad] = useState(false);
  const [entries, setEntries] = useState<RedisKeyEntry[]>([]);
  const [scanCursor, setScanCursor] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [dbsize, setDbsize] = useState(0);
  const [searching, setSearching] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [fetchingAll, setFetchingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set());
  const [rightTab, setRightTab] = useState<RightTab>("detail");
  const [createOpen, setCreateOpen] = useState(false);
  const [createKey, setCreateKey] = useState("");
  const [createValue, setCreateValue] = useState("");
  const [creating, setCreating] = useState(false);
  const [hitFetchAllLimit, setHitFetchAllLimit] = useState(false);
  const [typesMenuOpen, setTypesMenuOpen] = useState(false);

  const [deployment, setDeployment] = useState<RedisDeploymentInfo | null>(() =>
    capable ? readRedisDeploymentCache(connection) : null,
  );
  const [deploymentLoading, setDeploymentLoading] = useState(false);

  const searchRequestIdRef = useRef(0);
  const fetchAllCancelRef = useRef(false);
  const hasMoreRef = useRef(false);
  const scanCursorRef = useRef(0);
  const entriesLenRef = useRef(0);
  const searchingRef = useRef(false);
  const loadingMoreRef = useRef(false);
  const fetchingAllRef = useRef(false);
  const autoLoadRef = useRef(false);

  hasMoreRef.current = hasMore;
  scanCursorRef.current = scanCursor;
  entriesLenRef.current = entries.length;
  searchingRef.current = searching;
  loadingMoreRef.current = loadingMore;
  fetchingAllRef.current = fetchingAll;
  autoLoadRef.current = autoLoad;

  const scopedConnection = useMemo(
    () => connectionWithDatabase(connection, activeDb),
    [connection, activeDb],
  );

  const includeValuePreview = searchScope === "value" || searchScope === "all";
  const typesArray = useMemo(() => [...selectedTypes], [selectedTypes]);
  const typeFilterLabel =
    selectedTypes.size === ALL_KEY_TYPES.length
      ? t("database.redisQuery.typesAll")
      : selectedTypes.size === 0
        ? t("database.redisQuery.typesNone")
        : t("database.redisQuery.typesSelected", { count: selectedTypes.size });

  const visibleEntries = useMemo(() => {
    const scoped = filterEntriesBySearchScope(entries, keyword, searchScope, fuzzy);
    if (selectedTypes.size === ALL_KEY_TYPES.length) {
      return scoped;
    }
    return scoped.filter((entry) => selectedTypes.has(entry.keyType.toLowerCase()));
  }, [entries, keyword, searchScope, fuzzy, selectedTypes]);

  const tree = useMemo(() => buildRedisPrefixTree(visibleEntries), [visibleEntries]);

  const listRows = useMemo(() => {
    if (viewMode === "flat") {
      return flattenRedisEntries(visibleEntries);
    }
    return flattenRedisPrefixTree(tree, expandedFolders);
  }, [viewMode, visibleEntries, tree, expandedFolders]);

  const refreshDbsize = useCallback(async () => {
    if (!capable) {
      return;
    }
    try {
      const size = await redisDbsize(scopedConnection);
      setDbsize(size);
    } catch {
      /* ignore */
    }
  }, [capable, scopedConnection]);

  const fetchKeys = useCallback(
    async (options: {
      cursor: number;
      append: boolean;
      limit?: number;
      silent?: boolean;
    }) => {
      if (!capable) {
        return { nextCursor: 0, hasMore: false, batchSize: 0 };
      }
      if (typesArray.length === 0) {
        if (!options.append) {
          setEntries([]);
          setScanCursor(0);
          setHasMore(false);
        }
        return { nextCursor: 0, hasMore: false, batchSize: 0 };
      }

      const requestId = options.append ? searchRequestIdRef.current : ++searchRequestIdRef.current;
      const pattern = buildScanPattern(
        searchScope === "key" ? keyword : "",
        fuzzy,
      );

      try {
        const result = await redisSearchKeys({
          connection: scopedConnection,
          pattern,
          types: typesArray,
          limit: options.limit ?? SCAN_BATCH_LIMIT,
          cursor: options.cursor,
          includeValuePreview,
        });

        if (!options.append && requestId !== searchRequestIdRef.current) {
          return { nextCursor: 0, hasMore: false, batchSize: 0 };
        }

        const batch = result.entries ?? [];
        setEntries((prev) => (options.append ? [...prev, ...batch] : batch));
        setScanCursor(result.nextCursor);
        setHasMore(result.hasMore);
        return {
          nextCursor: result.nextCursor,
          hasMore: result.hasMore,
          batchSize: batch.length,
        };
      } catch (e) {
        if (!options.append && requestId !== searchRequestIdRef.current) {
          return { nextCursor: 0, hasMore: false, batchSize: 0 };
        }
        setError(typeof e === "string" ? e : JSON.stringify(e));
        if (!options.append) {
          setEntries([]);
          setScanCursor(0);
          setHasMore(false);
        }
        return { nextCursor: 0, hasMore: false, batchSize: 0 };
      }
    },
    [capable, scopedConnection, searchScope, keyword, fuzzy, includeValuePreview, typesArray],
  );

  const runSearch = useCallback(async () => {
    setSearching(true);
    setError(null);
    setHitFetchAllLimit(false);
    setSelectedKey(null);
    try {
      await refreshDbsize();
      await fetchKeys({ cursor: 0, append: false });
    } finally {
      setSearching(false);
    }
  }, [fetchKeys, refreshDbsize]);

  const loadMore = useCallback(
    async (options?: { silent?: boolean }) => {
      if (
        !hasMoreRef.current ||
        searchingRef.current ||
        loadingMoreRef.current ||
        fetchingAllRef.current
      ) {
        return;
      }
      const silent = options?.silent ?? false;
      if (!silent) {
        setLoadingMore(true);
      } else {
        // 静默加载也标记 busy，避免并发
        loadingMoreRef.current = true;
        setLoadingMore(true);
      }
      try {
        await fetchKeys({
          cursor: scanCursorRef.current,
          append: true,
          silent,
        });
      } finally {
        setLoadingMore(false);
      }
    },
    [fetchKeys],
  );

  const fetchAll = useCallback(async () => {
    if (searching || loadingMore || fetchingAll) {
      return;
    }
    setFetchingAll(true);
    setHitFetchAllLimit(false);
    fetchAllCancelRef.current = false;
    try {
      let cursor = scanCursorRef.current;
      let more = hasMoreRef.current;
      if (entriesLenRef.current === 0) {
        setSearching(true);
        await refreshDbsize();
        const first = await fetchKeys({ cursor: 0, append: false });
        setSearching(false);
        cursor = first.nextCursor;
        more = first.hasMore;
      }
      while (more && !fetchAllCancelRef.current) {
        if (entriesLenRef.current >= FETCH_ALL_HARD_LIMIT) {
          setHitFetchAllLimit(true);
          break;
        }
        const remain = FETCH_ALL_HARD_LIMIT - entriesLenRef.current;
        const result = await fetchKeys({
          cursor,
          append: true,
          limit: Math.min(SCAN_BATCH_LIMIT, remain),
        });
        cursor = result.nextCursor;
        more = result.hasMore;
        if (entriesLenRef.current >= FETCH_ALL_HARD_LIMIT && more) {
          setHitFetchAllLimit(true);
          break;
        }
      }
    } finally {
      setFetchingAll(false);
      setSearching(false);
    }
  }, [fetchKeys, refreshDbsize, searching, loadingMore, fetchingAll]);

  const handleNearBottom = useCallback(() => {
    if (!autoLoadRef.current) {
      return;
    }
    void loadMore({ silent: true });
  }, [loadMore]);

  useEffect(() => {
    if (!capable) {
      return;
    }
    void runSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capable, connection.id, activeDb]);

  // 类型筛选变更后重扫（避免仅本地过滤导致「还有更多」语义混乱）
  const typesKey = typesArray.slice().sort().join(",");
  const typesInitRef = useRef(true);
  useEffect(() => {
    if (typesInitRef.current) {
      typesInitRef.current = false;
      return;
    }
    if (!capable) {
      return;
    }
    void runSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typesKey]);

  useEffect(() => {
    if (!typesMenuOpen) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      if (!target.closest(".redis-query-type-filter")) {
        setTypesMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [typesMenuOpen]);

  useEffect(() => {
    if (!capable || rightTab !== "cli") {
      return;
    }
    const cached = readRedisDeploymentCache(connection);
    if (isRedisDeploymentCacheUsable(cached)) {
      setDeployment(cached);
      return;
    }
    let cancelled = false;
    setDeploymentLoading(true);
    void probeRedisDeployment(connection, sshConnections)
      .then((info) => {
        if (cancelled) return;
        writeRedisDeploymentCache(connection, info);
        setDeployment(info);
      })
      .catch(() => {
        if (cancelled) return;
        const fallback: RedisDeploymentInfo = { kind: "unknown", reason: "probe_failed" };
        writeRedisDeploymentCache(connection, fallback);
        setDeployment(fallback);
      })
      .finally(() => {
        if (!cancelled) {
          setDeploymentLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [capable, rightTab, connection, sshConnections]);

  const toggleFolder = useCallback((id: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

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

  const handleSearchKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void runSearch();
      }
    },
    [runSearch],
  );

  const handleCreate = useCallback(async () => {
    const key = createKey.trim();
    if (!key) {
      return;
    }
    setCreating(true);
    try {
      await redisSetKey(scopedConnection, key, createValue, "string");
      setCreateOpen(false);
      setCreateKey("");
      setCreateValue("");
      await runSearch();
      setSelectedKey(key);
      setRightTab("detail");
    } catch (e) {
      setError(typeof e === "string" ? e : JSON.stringify(e));
    } finally {
      setCreating(false);
    }
  }, [createKey, createValue, scopedConnection, runSearch]);

  const handleDeleted = useCallback(
    (key: string) => {
      setEntries((prev) => prev.filter((entry) => entry.key !== key));
      setSelectedKey(null);
      void refreshDbsize();
    },
    [refreshDbsize],
  );

  const handleSelectKey = useCallback((key: string) => {
    setSelectedKey(key);
    setRightTab("detail");
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

  const busy = searching || loadingMore || fetchingAll;

  return (
    <div className="redis-query-panel redis-query-panel--split">
      <div className="redis-query-left">
        <div className="redis-query-browser-header">
          <div className="redis-query-browser-row redis-query-browser-row--top">
            <div className="redis-query-scope" role="tablist">
              {(["key", "value", "all"] as const).map((scope) => (
                <button
                  key={scope}
                  type="button"
                  role="tab"
                  className={`redis-query-scope-btn${searchScope === scope ? " active" : ""}`}
                  onClick={() => setSearchScope(scope)}
                >
                  {t(`database.redisQuery.scope.${scope}`)}
                </button>
              ))}
            </div>
            <div className="redis-query-top-end">
              <span
                className="redis-query-progress"
                title={
                  hitFetchAllLimit
                    ? t("database.redisQuery.fetchAllLimit", { limit: FETCH_ALL_HARD_LIMIT })
                    : undefined
                }
              >
                {t("database.redisQuery.loadedProgress", {
                  loaded: entries.length,
                  total: dbsize,
                })}
              </span>
              <button
                type="button"
                className="redis-query-chip redis-query-chip--icon"
                onClick={() => setCreateOpen(true)}
                disabled={busy}
                title={t("database.redisQuery.createTitle")}
              >
                +
              </button>
            </div>
          </div>

          <div className="redis-query-browser-row">
            <TextInput
              copyable={false}
              className="redis-query-search-input"
              value={keyword}
              onChange={setKeyword}
              onKeyDown={handleSearchKeyDown}
              placeholder={t("database.redisQuery.searchPlaceholder")}
              disabled={busy}
              spellCheck={false}
            />
          </div>

          <div className="redis-query-browser-row redis-query-browser-row--actions">
            <div className="redis-query-type-filter">
              <button
                type="button"
                className={`redis-query-type-trigger${typesMenuOpen ? " active" : ""}`}
                onClick={() => setTypesMenuOpen((v) => !v)}
                title={t("database.redisQuery.types")}
              >
                {typeFilterLabel}
              </button>
              {typesMenuOpen ? (
                <div className="redis-query-type-menu">
                  <button
                    type="button"
                    className="redis-query-type-menu-action"
                    onClick={() => setSelectedTypes(new Set(ALL_KEY_TYPES))}
                  >
                    {t("database.redisQuery.typesSelectAll")}
                  </button>
                  {ALL_KEY_TYPES.map((type) => (
                    <label key={type} className="redis-query-type-menu-item">
                      <input
                        type="checkbox"
                        checked={selectedTypes.has(type)}
                        onChange={() => toggleType(type)}
                      />
                      <span>{type}</span>
                    </label>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="redis-query-view-toggle" role="group">
              <button
                type="button"
                className={`redis-query-view-btn${viewMode === "tree" ? " active" : ""}`}
                onClick={() => setViewMode("tree")}
                title={t("database.redisQuery.viewTree")}
              >
                {t("database.redisQuery.viewTree")}
              </button>
              <button
                type="button"
                className={`redis-query-view-btn${viewMode === "flat" ? " active" : ""}`}
                onClick={() => setViewMode("flat")}
                title={t("database.redisQuery.viewFlat")}
              >
                {t("database.redisQuery.viewFlat")}
              </button>
            </div>
            <button
              type="button"
              className={`redis-query-chip${fuzzy ? " active" : ""}`}
              onClick={() => setFuzzy((v) => !v)}
              title={t("database.redisQuery.fuzzy")}
            >
              * {t("database.redisQuery.fuzzy")}
            </button>
            <button
              type="button"
              className={`redis-query-chip${autoLoad ? " active" : ""}`}
              onClick={() => setAutoLoad((v) => !v)}
              title={t("database.redisQuery.autoLoadHint")}
            >
              {t("database.redisQuery.autoLoad")}
            </button>
            <button
              type="button"
              className="redis-query-chip"
              onClick={() => void runSearch()}
              disabled={busy}
            >
              {t("common.refresh")}
            </button>
            <button
              type="button"
              className="redis-query-chip"
              onClick={() => void fetchAll()}
              disabled={busy && !fetchingAll}
              title={t("database.redisQuery.fetchAll")}
            >
              {fetchingAll ? t("database.redisQuery.fetchingAll") : t("database.redisQuery.fetchAll")}
            </button>
          </div>
        </div>

        {error ? (
          <div className="db-table-designer-state db-table-designer-state--error">{error}</div>
        ) : searching && entries.length === 0 ? (
          <div className="db-table-designer-state">{t("common.loading")}</div>
        ) : listRows.length === 0 ? (
          <div className="db-table-designer-state">{t("database.redisQuery.empty")}</div>
        ) : (
          <RedisKeyBrowserList
            rows={listRows}
            selectedKey={selectedKey}
            onToggleFolder={toggleFolder}
            onSelectKey={handleSelectKey}
            onNearBottom={autoLoad ? handleNearBottom : undefined}
            loadingMore={loadingMore && autoLoad}
          />
        )}
      </div>

      <div className="redis-query-right">
        <div className="redis-query-right-tabs" role="tablist">
          {(
            [
              ["detail", "database.redisQuery.tabs.detail"],
              ["cli", "database.redisQuery.tabs.cli"],
              ["pubsub", "database.redisQuery.tabs.pubsub"],
              ["slowlog", "database.redisQuery.tabs.slowlog"],
            ] as const
          ).map(([id, labelKey]) => (
            <button
              key={id}
              type="button"
              role="tab"
              className={`db-toolbox-tab${rightTab === id ? " active" : ""}`}
              onClick={() => setRightTab(id)}
            >
              {t(labelKey)}
            </button>
          ))}
        </div>
        <div className="redis-query-right-body">
          <div
            className={
              rightTab === "detail"
                ? "redis-query-right-pane"
                : "redis-query-right-pane redis-query-right-pane--hidden"
            }
          >
            <RedisKeyDetailPanel
              connection={connection}
              dbName={activeDb}
              selectedKey={selectedKey}
              active={rightTab === "detail"}
              onDeleted={handleDeleted}
            />
          </div>
          <div
            className={
              rightTab === "cli"
                ? "redis-query-right-pane"
                : "redis-query-right-pane redis-query-right-pane--hidden"
            }
          >
            <ConnectionCliTabPanel
              connection={scopedConnection}
              client="redis"
              deployment={deployment}
              deploymentLoading={deploymentLoading}
              sshConnections={sshConnections}
              panelActive
              visible={rightTab === "cli"}
            />
          </div>
          <div
            className={
              rightTab === "pubsub"
                ? "redis-query-right-pane"
                : "redis-query-right-pane redis-query-right-pane--hidden"
            }
          >
            <RedisPubSubPanel
              initialHost={connection.host}
              initialPort={String(connection.port || 6379)}
              initialDatabase={activeDb}
              initialUsername={connection.user}
              initialPassword={connection.password}
              compact
            />
          </div>
          <div
            className={
              rightTab === "slowlog"
                ? "redis-query-right-pane"
                : "redis-query-right-pane redis-query-right-pane--hidden"
            }
          >
            <RedisSlowLogPanel
              connection={connection}
              dbName={activeDb}
              active={rightTab === "slowlog"}
            />
          </div>
        </div>
      </div>

      {createOpen ? (
        <div className="redis-create-dialog-backdrop">
          <div className="redis-create-dialog">
            <div className="redis-create-dialog-title">{t("database.redisQuery.createTitle")}</div>
            <label className="redis-create-field">
              <span>{t("database.redisQuery.createKey")}</span>
              <TextInput copyable={false} value={createKey} onChange={setCreateKey} />
            </label>
            <label className="redis-create-field">
              <span>{t("database.redisQuery.createValue")}</span>
              <TextInput copyable={false} value={createValue} onChange={setCreateValue} />
            </label>
            <div className="redis-create-dialog-actions">
              <Button variant="ghost" size="sm" onClick={() => setCreateOpen(false)}>
                {t("common.cancel")}
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => void handleCreate()}
                disabled={creating || !createKey.trim()}
              >
                {t("common.confirm")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
