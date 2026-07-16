import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../../i18n";
import { textSearchMatches } from "../../../lib/textSearchMatch";
import { fetchTableDdl, fetchTableDetails, type DbTableDetails } from "../api";
import { supportsTableDesign } from "../tableDesigner/resolveTableDesignerDriver";
import { formatSqlDdl } from "../sql/formatSqlDdl";
import type { SchemaDatabaseSelection, SchemaTableSelection } from "../schema/SchemaBrowser";
import { TableDdlViewer } from "../table/TableDdlViewer";
import { useDbSchemaCacheStore } from "../../../stores/dbSchemaCacheStore";
import { getCachedTableCommentMap, getCachedTableNames } from "../schema/schemaCacheMerge";
import {
  displayDetailValue,
  formatTableDataSummary,
} from "./databaseTablesPanelFormat";
import { DbTablesPanelGrid, type DbTablesPanelGridColumn } from "./DbTablesPanelGrid";
import { DbPanelMetaRefreshButton } from "./DbPanelMetaRefreshButton";
import {
  readTableDetailsCacheMap,
  writeTableDetailsCache,
} from "./tableDetailsCache";
import {
  clearTableDdlCacheForDatabase,
  readTableDdlCache,
  writeTableDdlCache,
} from "./tableDdlCache";
import { DetailPanelShell } from "../../../components/ui/layout/DetailPanelShell";
import { Button } from "../../../components/ui/primitives/Button";
import { TextInput } from "../../../components/ui/form/TextInput";

interface DatabaseTablesPanelProps {
  selection: SchemaDatabaseSelection;
  onDesignTable?: (selection: SchemaTableSelection) => void;
  onOpenTableData?: (selection: SchemaTableSelection) => void;
}

type TableDetailEntry =
  | { status: "loading" }
  | { status: "loaded"; details: DbTableDetails }
  | { status: "error" };

type TableDdlEntry =
  | { status: "loading" }
  | { status: "loaded"; ddl: string }
  | { status: "error"; message: string };

type TablesPanelSortColumn = "name" | "data";
type TablesPanelSortDirection = "asc" | "desc";

interface TablesPanelSortState {
  column: TablesPanelSortColumn;
  direction: TablesPanelSortDirection;
}

function resolveTableDataSortKey(entry: TableDetailEntry | undefined): number | null {
  if (!entry || entry.status !== "loaded") {
    return null;
  }
  const { rowCount, dataLength } = entry.details;
  if (dataLength != null && dataLength >= 0) {
    return dataLength;
  }
  if (rowCount != null && rowCount >= 0) {
    return rowCount;
  }
  return null;
}

function compareTableNames(a: string, b: string, direction: TablesPanelSortDirection): number {
  const cmp = a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
  return direction === "asc" ? cmp : -cmp;
}

function compareTableData(
  a: string,
  b: string,
  detailsByTable: Record<string, TableDetailEntry>,
  direction: TablesPanelSortDirection,
): number {
  const aKey = resolveTableDataSortKey(detailsByTable[a]);
  const bKey = resolveTableDataSortKey(detailsByTable[b]);
  if (aKey == null && bKey == null) {
    return compareTableNames(a, b, "asc");
  }
  if (aKey == null) {
    return 1;
  }
  if (bKey == null) {
    return -1;
  }
  if (aKey !== bKey) {
    const cmp = aKey - bKey;
    return direction === "asc" ? cmp : -cmp;
  }
  return compareTableNames(a, b, "asc");
}

const DETAILS_FETCH_CONCURRENCY = 4;

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function resolveDetailCell(
  entry: TableDetailEntry | undefined,
  render: (details: DbTableDetails) => string,
  loadingLabel: string,
): string {
  if (!entry || entry.status === "error") {
    return "—";
  }
  if (entry.status === "loading") {
    return loadingLabel;
  }
  return render(entry.details);
}

export function DatabaseTablesPanel({
  selection,
  onDesignTable,
  onOpenTableData,
}: DatabaseTablesPanelProps) {
  const { t } = useI18n();
  const hydrateSchemaCache = useDbSchemaCacheStore((s) => s.hydrate);
  const cacheHydrated = useDbSchemaCacheStore((s) => s.hydrated);
  const schemaSnapshot = useDbSchemaCacheStore((s) => s.snapshot);
  const [search, setSearch] = useState("");
  const [detailsByTable, setDetailsByTable] = useState<Record<string, TableDetailEntry>>({});
  const [ddlByTable, setDdlByTable] = useState<Record<string, TableDdlEntry>>({});
  const [selectedTableName, setSelectedTableName] = useState<string | null>(null);
  const [sort, setSort] = useState<TablesPanelSortState>({ column: "name", direction: "asc" });
  const [detailsRefreshing, setDetailsRefreshing] = useState(false);
  const [ddlDrawerOpen, setDdlDrawerOpen] = useState(false);
  const [ddlDrawerTableName, setDdlDrawerTableName] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!cacheHydrated) {
      void hydrateSchemaCache();
    }
  }, [cacheHydrated, hydrateSchemaCache]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        if (search) {
          setSearch("");
          e.preventDefault();
        }
        return;
      }
      if (e.key.length !== 1) return;
      const target = e.target as HTMLElement;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      if (!panel.contains(target)) return;
      e.preventDefault();
      setSearch((prev) => prev + e.key);
      searchInputRef.current?.focus();
      requestAnimationFrame(() => {
        const input = searchInputRef.current;
        if (input) {
          const len = input.value.length;
          input.setSelectionRange(len, len);
        }
      });
    };

    panel.addEventListener("keydown", handleKeyDown);
    return () => panel.removeEventListener("keydown", handleKeyDown);
  }, [search]);

  useEffect(() => {
    setSearch("");
    setSelectedTableName(null);
    setDetailsByTable({});
    setDdlByTable({});
    setSort({ column: "name", direction: "asc" });
  }, [selection.connId, selection.dbName]);

  const tables = useMemo(
    () => getCachedTableNames(schemaSnapshot, selection.connId, selection.dbName),
    [schemaSnapshot, selection.connId, selection.dbName],
  );

  const tableComments = useMemo(
    () => getCachedTableCommentMap(schemaSnapshot, selection.connId, selection.dbName),
    [schemaSnapshot, selection.connId, selection.dbName],
  );

  const filteredTables = useMemo(() => {
    const q = search.trim();
    if (!q) {
      return tables;
    }
    return tables.filter((tableName) => {
      const comment = tableComments.get(tableName);
      return (
        textSearchMatches(q, tableName) ||
        (comment !== undefined && textSearchMatches(q, comment))
      );
    });
  }, [search, tables, tableComments]);

  const sortedTables = useMemo(() => {
    const list = [...filteredTables];
    list.sort((a, b) => {
      if (sort.column === "name") {
        return compareTableNames(a, b, sort.direction);
      }
      return compareTableData(a, b, detailsByTable, sort.direction);
    });
    return list;
  }, [detailsByTable, filteredTables, sort]);

  const toggleSort = useCallback((column: TablesPanelSortColumn) => {
    setSort((prev) => {
      if (prev.column === column) {
        return { column, direction: prev.direction === "asc" ? "desc" : "asc" };
      }
      return {
        column,
        direction: column === "name" ? "asc" : "desc",
      };
    });
  }, []);

  const loadTableDetails = useCallback(
    async (tableNames: string[], options?: { force?: boolean }) => {
      if (tableNames.length === 0) {
        return;
      }

      const force = options?.force ?? false;
      const cachedMap = force
        ? {}
        : readTableDetailsCacheMap(
            selection.connId,
            selection.dbName,
            tableNames,
            selection.connection,
          );

      const toFetch = force
        ? tableNames
        : tableNames.filter((tableName) => !cachedMap[tableName]);

      setDetailsByTable((prev) => {
        const next = { ...prev };
        for (const tableName of tableNames) {
          const cached = cachedMap[tableName];
          if (cached) {
            next[tableName] = { status: "loaded", details: cached };
          } else if (force || !next[tableName] || next[tableName].status !== "loaded") {
            next[tableName] = { status: "loading" };
          }
        }
        return next;
      });

      if (toFetch.length === 0) {
        return;
      }

      await mapWithConcurrency(toFetch, DETAILS_FETCH_CONCURRENCY, async (tableName) => {
        try {
          const details = await fetchTableDetails(
            selection.connection,
            selection.dbName,
            tableName,
          );
          writeTableDetailsCache(
            selection.connId,
            selection.dbName,
            tableName,
            selection.connection,
            details,
          );
          setDetailsByTable((prev) => ({
            ...prev,
            [tableName]: { status: "loaded", details },
          }));
        } catch {
          setDetailsByTable((prev) => ({
            ...prev,
            [tableName]: { status: "error" },
          }));
        }
      });
    },
    [selection.connId, selection.connection, selection.dbName],
  );

  const loadTableDdl = useCallback(
    async (tableName: string, options?: { force?: boolean }) => {
      const force = options?.force ?? false;
      if (!force) {
        const cached = readTableDdlCache(
          selection.connId,
          selection.dbName,
          tableName,
          selection.connection,
        );
        if (cached) {
          setDdlByTable((prev) => ({
            ...prev,
            [tableName]: { status: "loaded", ddl: cached },
          }));
          return;
        }
      }

      setDdlByTable((prev) => ({
        ...prev,
        [tableName]: { status: "loading" },
      }));

      try {
        const raw = await fetchTableDdl(selection.connection, selection.dbName, tableName);
        const formatted = formatSqlDdl(raw, selection.connection.db_type);
        writeTableDdlCache(
          selection.connId,
          selection.dbName,
          tableName,
          selection.connection,
          formatted,
        );
        setDdlByTable((prev) => ({
          ...prev,
          [tableName]: { status: "loaded", ddl: formatted },
        }));
      } catch (err) {
        setDdlByTable((prev) => ({
          ...prev,
          [tableName]: { status: "error", message: String(err) },
        }));
      }
    },
    [selection.connId, selection.connection, selection.dbName],
  );

  const handleRefreshDetails = useCallback(async () => {
    if (tables.length === 0) {
      return;
    }
    setDetailsRefreshing(true);
    try {
      clearTableDdlCacheForDatabase(selection.connId, selection.dbName);
      setDdlByTable({});
      await loadTableDetails(tables, { force: true });
      if (selectedTableName) {
        await loadTableDdl(selectedTableName, { force: true });
      }
    } finally {
      setDetailsRefreshing(false);
    }
  }, [loadTableDetails, loadTableDdl, selectedTableName, selection.connId, selection.dbName, tables]);

  // 先进去再拉详情：表名来自本地缓存即可立刻渲染；行数/引擎等后台空闲再填，避免重启后首进卡在建连风暴
  useEffect(() => {
    if (tables.length === 0) {
      setDetailsByTable({});
      return;
    }
    let cancelled = false;
    const run = () => {
      if (!cancelled) {
        void loadTableDetails(tables);
      }
    };
    let idleId: number | null = null;
    let timerId: number | null = null;
    if (typeof requestIdleCallback === "function") {
      idleId = requestIdleCallback(run, { timeout: 500 });
    } else {
      timerId = window.setTimeout(run, 0);
    }
    return () => {
      cancelled = true;
      if (idleId != null && typeof cancelIdleCallback === "function") {
        cancelIdleCallback(idleId);
      }
      if (timerId != null) {
        window.clearTimeout(timerId);
      }
    };
  }, [loadTableDetails, tables]);

  const activeDdlTableName = ddlDrawerOpen ? ddlDrawerTableName : selectedTableName;

  useEffect(() => {
    if (!activeDdlTableName) {
      return;
    }
    void loadTableDdl(activeDdlTableName);
  }, [loadTableDdl, activeDdlTableName]);

  const selectedDdlEntry = activeDdlTableName ? ddlByTable[activeDdlTableName] : undefined;
  const ddl = selectedDdlEntry?.status === "loaded" ? selectedDdlEntry.ddl : "";
  const ddlLoading = selectedDdlEntry?.status === "loading";
  const ddlError = selectedDdlEntry?.status === "error" ? selectedDdlEntry.message : null;

  const handleOpenDdlDrawer = useCallback(
    (tableName: string) => {
      setDdlDrawerTableName(tableName);
      setDdlDrawerOpen(true);
    },
    [],
  );

  const handleCloseDdlDrawer = useCallback(() => {
    setDdlDrawerOpen(false);
  }, []);

  const handleDesignTable = useCallback(
    (tableName: string) => {
      onDesignTable?.({
        connId: selection.connId,
        dbName: selection.dbName,
        tableName,
        connection: selection.connection,
      });
    },
    [onDesignTable, selection.connId, selection.dbName, selection.connection],
  );

  const handleOpenTableData = useCallback(
    (tableName: string) => {
      onOpenTableData?.({
        connId: selection.connId,
        dbName: selection.dbName,
        tableName,
        connection: selection.connection,
      });
    },
    [onOpenTableData, selection.connId, selection.dbName, selection.connection],
  );

  const canDesign = Boolean(onDesignTable) && supportsTableDesign(selection.connection);
  const canOpenTableData = Boolean(onOpenTableData);

  const handleCopyDdl = useCallback(async () => {
    if (!ddl || ddlLoading || ddlError) {
      return;
    }

    const clip = navigator.clipboard;
    if (clip && typeof clip.writeText === "function") {
      try {
        await clip.writeText(ddl);
        return;
      } catch (err) {
        console.error("[clipboard] writeText failed, falling back", err);
      }
    }

    const ta = document.createElement("textarea");
    ta.value = ddl;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch (err) {
      console.error("[clipboard] execCommand failed", err);
    }
    document.body.removeChild(ta);
  }, [ddl, ddlError, ddlLoading]);

  const canCopyDdl = Boolean(ddl && !ddlLoading && !ddlError);
  const cacheReady = cacheHydrated && Boolean(schemaSnapshot.connections[selection.connId]);
  const tableCount = tables.length;
  const loadingLabel = t("database.tablesPanel.detailsLoading");

  const tableColumns = useMemo((): DbTablesPanelGridColumn<string>[] => {
    const cols: DbTablesPanelGridColumn<string>[] = [
      {
        id: "name",
        header: t("database.tablesPanel.columns.name"),
        sortable: true,
        nameCell: true,
        render: (tableName) => tableName,
        getTitle: (tableName) => tableName,
      },
      {
        id: "comment",
        header: t("database.tablesPanel.details.comment"),
        render: (tableName) => {
          const entry = detailsByTable[tableName];
          const fallbackComment = tableComments.get(tableName);
          if (entry?.status === "loaded") {
            return displayDetailValue(entry.details.comment ?? fallbackComment ?? null);
          }
          if (entry?.status === "loading") {
            return loadingLabel;
          }
          return displayDetailValue(fallbackComment);
        },
        getTitle: (tableName) => {
          const entry = detailsByTable[tableName];
          const fallbackComment = tableComments.get(tableName);
          if (entry?.status === "loaded") {
            return displayDetailValue(entry.details.comment ?? fallbackComment ?? null);
          }
          if (entry?.status === "loading") {
            return loadingLabel;
          }
          return displayDetailValue(fallbackComment);
        },
      },
      {
        id: "engine",
        header: t("database.tablesPanel.details.engine"),
        render: (tableName) =>
          resolveDetailCell(
            detailsByTable[tableName],
            (details) => displayDetailValue(details.engine ?? null),
            loadingLabel,
          ),
        getCopyValue: (tableName) =>
          resolveDetailCell(
            detailsByTable[tableName],
            (details) => displayDetailValue(details.engine ?? null),
            loadingLabel,
          ),
      },
      {
        id: "data",
        header: t("database.tablesPanel.details.data"),
        sortable: true,
        render: (tableName) =>
          resolveDetailCell(
            detailsByTable[tableName],
            (details) =>
              formatTableDataSummary(details.rowCount ?? null, details.dataLength ?? null),
            loadingLabel,
          ),
        getCopyValue: (tableName) =>
          resolveDetailCell(
            detailsByTable[tableName],
            (details) =>
              formatTableDataSummary(details.rowCount ?? null, details.dataLength ?? null),
            loadingLabel,
          ),
      },
      {
        id: "rowFormat",
        header: t("database.tablesPanel.details.rowFormat"),
        render: (tableName) =>
          resolveDetailCell(
            detailsByTable[tableName],
            (details) => displayDetailValue(details.rowFormat ?? null),
            loadingLabel,
          ),
        getCopyValue: (tableName) =>
          resolveDetailCell(
            detailsByTable[tableName],
            (details) => displayDetailValue(details.rowFormat ?? null),
            loadingLabel,
          ),
      },
      {
        id: "collation",
        header: t("database.tablesPanel.details.collation"),
        render: (tableName) =>
          resolveDetailCell(
            detailsByTable[tableName],
            (details) => displayDetailValue(details.collation ?? null),
            loadingLabel,
          ),
        getCopyValue: (tableName) =>
          resolveDetailCell(
            detailsByTable[tableName],
            (details) => displayDetailValue(details.collation ?? null),
            loadingLabel,
          ),
      },
    ];

    cols.push({
      id: "actions",
      variant: "actions",
      header: null,
      headerAriaLabel: t("database.tablesPanel.actions"),
      render: (tableName) => (
        <div className="db-tables-panel-row-actions">
          <button
            type="button"
            className="btn-icon db-tables-panel-ddl-btn"
            title={t("database.contextMenu.viewDdl")}
            aria-label={t("database.contextMenu.viewDdl")}
            onClick={(event) => {
              event.stopPropagation();
              handleOpenDdlDrawer(tableName);
            }}
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" width="14" height="14" aria-hidden>
              <path d="M4 3h8M4 8h8M4 13h5" />
            </svg>
          </button>
          {canOpenTableData ? (
            <button
              type="button"
              className="btn-icon db-tables-panel-data-btn"
              title={t("database.contextMenu.viewTableData")}
              aria-label={t("database.contextMenu.viewTableData")}
              onClick={(event) => {
                event.stopPropagation();
                handleOpenTableData(tableName);
              }}
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" width="14" height="14" aria-hidden>
                <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
                <path d="M2.5 6h11M2.5 9.5h11M6 2.5v11M10 2.5v11" />
              </svg>
            </button>
          ) : null}
          {canDesign ? (
            <button
              type="button"
              className="btn-icon db-tables-panel-design-btn"
              title={t("database.contextMenu.designTable")}
              aria-label={t("database.contextMenu.designTable")}
              onClick={(event) => {
                event.stopPropagation();
                handleDesignTable(tableName);
              }}
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" width="14" height="14" aria-hidden>
                <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
                <path d="M5 8h6M8 5v6" />
              </svg>
            </button>
          ) : null}
        </div>
      ),
    });

    return cols;
  }, [canDesign, canOpenTableData, detailsByTable, handleDesignTable, handleOpenDdlDrawer, handleOpenTableData, loadingLabel, t, tableComments]);

  return (
    <div ref={panelRef} className="db-tables-panel db-tables-panel--dock">
      <div className="db-tables-panel-toolbar">
        <div className="db-tables-panel-toolbar-left">
          <Button variant="primary" size="sm" onClick={() => onDesignTable?.({
            connId: selection.connId,
            dbName: selection.dbName,
            tableName: "",
            connection: selection.connection,
          })}>
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14" aria-hidden>
              <path d="M8 3v10M3 8h10" />
            </svg>
            <span>{t("database.tablesPanel.newTable")}</span>
          </Button>
        </div>
        <div className="db-tables-panel-toolbar-right">
          <TextInput
            ref={searchInputRef}
            className="db-tables-panel-search-input"
            value={search}
            onChange={setSearch}
            placeholder={t("database.tablesPanel.search")}
            clearable
            copyable={false}
            spellCheck={false}
            autoComplete="off"
          />
        </div>
      </div>

      <div className="db-tables-panel-body">
        <div className="db-tables-panel-list-pane">
          <div className="db-tables-panel-grid-wrap">
            {!cacheReady && (
              <div className="db-tables-panel-empty">{t("database.tablesPanel.cacheEmptyHint")}</div>
            )}
            {cacheReady && tableCount === 0 && (
              <div className="db-tables-panel-empty">{t("database.sidebar.noTables")}</div>
            )}
            {cacheReady && tableCount > 0 && (
              <DbTablesPanelGrid
                columns={tableColumns}
                rows={sortedTables}
                rowKey={(tableName) => tableName}
                sortColumnId={sort.column}
                sortDirection={sort.direction}
                onSortColumn={(columnId) => toggleSort(columnId as TablesPanelSortColumn)}
                selectedRowKey={selectedTableName}
                onRowClick={setSelectedTableName}
              />
            )}
            {cacheReady && tableCount > 0 && filteredTables.length === 0 && (
              <div className="db-tables-panel-empty">{t("database.tablesPanel.noResults")}</div>
            )}
          </div>
        </div>
      </div>

      <div className="db-tables-panel-meta">
        <DbPanelMetaRefreshButton
          onClick={() => void handleRefreshDetails()}
          disabled={!cacheReady || tables.length === 0}
          busy={detailsRefreshing}
        />
        <span className="db-tables-panel-meta-text">
          {!cacheReady
            ? t("database.tablesPanel.cacheEmpty")
            : detailsRefreshing
              ? t("common.loading")
              : t("database.tablesPanel.count", { count: tableCount })}
        </span>
      </div>

      <DetailPanelShell
        open={ddlDrawerOpen}
        onClose={handleCloseDdlDrawer}
        ariaLabel={t("database.tablesPanel.ddl")}
        floatingTitle={ddlDrawerTableName ?? t("database.tablesPanel.ddl")}
        variant="docker-drawer"
        widthRatio={0.5}
      >
        <div className="db-tables-panel-ddl">
          {!ddlDrawerTableName ? (
            <div className="db-tables-panel-ddl-empty">
              {t("database.tablesPanel.ddlEmpty")}
            </div>
          ) : (
            <>
              <div className="db-tables-panel-ddl-header">
                <span className="db-tables-panel-ddl-title">{ddlDrawerTableName}</span>
                <button
                  type="button"
                  className="btn-icon db-tables-panel-ddl-copy"
                  title={t("database.contextMenu.copyDdl")}
                  aria-label={t("database.contextMenu.copyDdl")}
                  disabled={!canCopyDdl}
                  onClick={() => void handleCopyDdl()}
                >
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
                    <rect x="5" y="5" width="9" height="9" rx="1.5" />
                    <path d="M3 11V3.5A1.5 1.5 0 0 1 4.5 2H11" />
                  </svg>
                </button>
              </div>
              <div className="db-tables-panel-ddl-content">
                {ddlLoading && (
                  <div className="db-tables-panel-ddl-status">{t("database.tablesPanel.ddlLoading")}</div>
                )}
                {!ddlLoading && ddlError && (
                  <div className="db-tables-panel-ddl-status db-tables-panel-ddl-status--error">
                    {t("database.tablesPanel.ddlFailed", { message: ddlError })}
                  </div>
                )}
                {!ddlLoading && !ddlError && ddl && <TableDdlViewer ddl={ddl} />}
              </div>
            </>
          )}
        </div>
      </DetailPanelShell>
    </div>
  );
}
