import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "../../../i18n";
import { textSearchMatches } from "../../../lib/textSearchMatch";
import { appConfirm } from "../../../lib/appConfirm";
import { fetchTableDdl, fetchDatabaseTableDetails, isConnectionEnabled, isMysqlConnectionInfoCapable, listDatabasesWithStats, type DbDatabaseMeta, type DbTableDetails } from "../api";
import { supportsTableDesign } from "../tableDesigner/resolveTableDesignerDriver";
import { formatSqlDdl } from "../sql/formatSqlDdl";
import { makeQueryRunId } from "../sql";
import type { SchemaDatabaseSelection, SchemaTableSelection } from "../schema/SchemaBrowser";
import { TableDdlViewer } from "../table/TableDdlViewer";
import { useDbSchemaCacheStore } from "../../../stores/dbSchemaCacheStore";
import { useDbSchemaFilterStore } from "../../../stores/dbSchemaFilterStore";
import { makeTableFilterKey, mergeFilter } from "../schema/DatabaseFilterDialog";
import { getCachedTableCommentMap, getCachedTableNames } from "../schema/schemaCacheMerge";
import { buildDatabaseTreeItem } from "../schema/schemaTreeItem";
import { refreshAndApplySchemaTreeNode } from "../schema/schemaTreeRefresh";
import { buildDropTableSql, isSchemaDropSqlSupported } from "../schema/schemaTreeDropSql";
import {
  allocateCloneTableName,
  buildCloneTableSql,
  isCloneTableSqlSupported,
} from "../schema/tableCloneSql";
import {
  displayDetailValue,
  formatTableDataSummary,
} from "./databaseTablesPanelFormat";
import { formatBytes } from "../../../stores/sshStatsStore";
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
import { ContextMenu, type ContextMenuItem } from "../../../components/ui/menu/ContextMenu";
import { showToast } from "../../../stores/toastStore";

interface DatabaseTablesPanelProps {
  selection: SchemaDatabaseSelection;
  onDesignTable?: (selection: SchemaTableSelection) => void;
  onOpenTableData?: (selection: SchemaTableSelection) => void;
  onExportDatabase?: (selection: SchemaDatabaseSelection) => void;
  onImportDatabase?: (selection: SchemaDatabaseSelection) => void;
}

const DATABASES_CACHE_PREFIX = "db-conn-info-databases-cache:";

function readDatabasesCache(connectionId: string): DbDatabaseMeta[] | null {
  try {
    const raw = localStorage.getItem(DATABASES_CACHE_PREFIX + connectionId);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed as DbDatabaseMeta[];
  } catch {
    return null;
  }
}

function findDatabaseMeta(
  list: DbDatabaseMeta[] | null | undefined,
  dbName: string,
): DbDatabaseMeta | null {
  if (!list) return null;
  return list.find((item) => item.name === dbName) ?? null;
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

const PLACEHOLDER_CELL = "—";

function resolveDetailCell(
  entry: TableDetailEntry | undefined,
  render: (details: DbTableDetails) => string,
  _loadingLabel: string,
): string {
  if (!entry || entry.status === "error") {
    return PLACEHOLDER_CELL;
  }
  if (entry.status === "loading") {
    return PLACEHOLDER_CELL;
  }
  return render(entry.details);
}

export function DatabaseTablesPanel({
  selection,
  onDesignTable,
  onOpenTableData,
  onExportDatabase,
  onImportDatabase,
}: DatabaseTablesPanelProps) {
  const { t } = useI18n();
  const hydrateSchemaCache = useDbSchemaCacheStore((s) => s.hydrate);
  const cacheHydrated = useDbSchemaCacheStore((s) => s.hydrated);
  const schemaSnapshot = useDbSchemaCacheStore((s) => s.snapshot);
  const [search, setSearch] = useState("");
  const [detailsByTable, setDetailsByTable] = useState<Record<string, TableDetailEntry>>({});
  const [ddlByTable, setDdlByTable] = useState<Record<string, TableDdlEntry>>({});
  const [selectedTableNames, setSelectedTableNames] = useState<Set<string>>(() => new Set());
  const [sort, setSort] = useState<TablesPanelSortState>({ column: "name", direction: "asc" });
  const [detailsRefreshing, setDetailsRefreshing] = useState(false);
  const [schemaRefreshing, setSchemaRefreshing] = useState(false);
  const [dbMeta, setDbMeta] = useState<DbDatabaseMeta | null>(() =>
    findDatabaseMeta(readDatabasesCache(selection.connId), selection.dbName),
  );
  const [ddlDrawerOpen, setDdlDrawerOpen] = useState(false);
  const [ddlDrawerTableName, setDdlDrawerTableName] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; tableName: string } | null>(
    null,
  );
  const searchInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const selectionAnchorRef = useRef<string | null>(null);
  const clipboardTablesRef = useRef<string[]>([]);

  const selectedTableName =
    selectedTableNames.size === 1 ? [...selectedTableNames][0]! : null;

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
        if (contextMenu) {
          setContextMenu(null);
          e.preventDefault();
          return;
        }
        if (selectedTableNames.size > 0) {
          setSelectedTableNames(new Set());
          selectionAnchorRef.current = null;
          e.preventDefault();
          return;
        }
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
  }, [search, contextMenu, selectedTableNames.size]);

  useEffect(() => {
    setSearch("");
    setSelectedTableNames(new Set());
    selectionAnchorRef.current = null;
    setDetailsByTable({});
    setDdlByTable({});
    setSort({ column: "name", direction: "asc" });
    setContextMenu(null);
    setDbMeta(findDatabaseMeta(readDatabasesCache(selection.connId), selection.dbName));
  }, [selection.connId, selection.dbName]);

  useEffect(() => {
    let cancelled = false;
    const cached = findDatabaseMeta(readDatabasesCache(selection.connId), selection.dbName);
    if (cached) {
      setDbMeta(cached);
    }

    void (async () => {
      try {
        const list = await listDatabasesWithStats(selection.connection, { quiet: true });
        if (cancelled) return;
        setDbMeta(findDatabaseMeta(list, selection.dbName));
      } catch {
        // 保留缓存；静默失败
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selection.connId, selection.connection, selection.dbName]);

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

  useEffect(() => {
    setSelectedTableNames((prev) => {
      if (prev.size === 0) return prev;
      const visible = new Set(sortedTables);
      let changed = false;
      const next = new Set<string>();
      for (const name of prev) {
        if (visible.has(name)) {
          next.add(name);
        } else {
          changed = true;
        }
      }
      if (!changed) return prev;
      if (selectionAnchorRef.current && !visible.has(selectionAnchorRef.current)) {
        selectionAnchorRef.current = next.size > 0 ? [...next][0]! : null;
      }
      return next;
    });
  }, [sortedTables]);

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

      try {
        const listed = await fetchDatabaseTableDetails(
          selection.connection,
          selection.dbName,
        );
        const wanted = new Set(toFetch);
        const nextPatch: Record<string, TableDetailEntry> = {};
        for (const item of listed) {
          if (!wanted.has(item.name)) {
            continue;
          }
          writeTableDetailsCache(
            selection.connId,
            selection.dbName,
            item.name,
            selection.connection,
            item.details,
          );
          nextPatch[item.name] = { status: "loaded", details: item.details };
        }
        for (const tableName of toFetch) {
          if (!nextPatch[tableName]) {
            nextPatch[tableName] = { status: "error" };
          }
        }
        setDetailsByTable((prev) => ({ ...prev, ...nextPatch }));
      } catch {
        setDetailsByTable((prev) => {
          const next = { ...prev };
          for (const tableName of toFetch) {
            next[tableName] = { status: "error" };
          }
          return next;
        });
      }
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

  // 先进去再拉详情：先同步灌本地缓存稳住列内容，缺失项后台一次批量拉取
  useEffect(() => {
    if (tables.length === 0) {
      setDetailsByTable({});
      return;
    }

    const cachedMap = readTableDetailsCacheMap(
      selection.connId,
      selection.dbName,
      tables,
      selection.connection,
    );
    setDetailsByTable((prev) => {
      const next = { ...prev };
      for (const tableName of tables) {
        const cached = cachedMap[tableName];
        if (cached) {
          next[tableName] = { status: "loaded", details: cached };
        } else if (!next[tableName] || next[tableName].status !== "loaded") {
          next[tableName] = { status: "loading" };
        }
      }
      return next;
    });

    const missing = tables.filter((tableName) => !cachedMap[tableName]);
    if (missing.length === 0) {
      return;
    }

    let cancelled = false;
    const run = () => {
      if (!cancelled) {
        void loadTableDetails(missing);
      }
    };
    let idleId: number | null = null;
    let timerId: number | null = null;
    if (typeof requestIdleCallback === "function") {
      idleId = requestIdleCallback(run, { timeout: 300 });
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
  }, [loadTableDetails, selection.connId, selection.connection, selection.dbName, tables]);

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

  const refreshDatabaseTables = useCallback(async () => {
    setSchemaRefreshing(true);
    try {
      const dbItem = buildDatabaseTreeItem(selection.connId, selection.dbName);
      await refreshAndApplySchemaTreeNode(selection.connection, dbItem, {
        syncTableFilter: (connId, dbName, names, options) => {
          const key = makeTableFilterKey(connId, dbName);
          useDbSchemaFilterStore.getState().setTableFilters((prev) => ({
            ...prev,
            [key]: mergeFilter(prev[key], names, options),
          }));
        },
      });
      try {
        const list = await listDatabasesWithStats(selection.connection, { quiet: true });
        setDbMeta(findDatabaseMeta(list, selection.dbName));
      } catch {
        // ignore meta refresh failure
      }
    } finally {
      setSchemaRefreshing(false);
    }
  }, [selection.connId, selection.connection, selection.dbName]);

  const handleNewTable = useCallback(() => {
    onDesignTable?.({
      connId: selection.connId,
      dbName: selection.dbName,
      tableName: "",
      connection: selection.connection,
    });
  }, [onDesignTable, selection.connId, selection.dbName, selection.connection]);

  const selectedNamesOrdered = useMemo(
    () => sortedTables.filter((name) => selectedTableNames.has(name)),
    [selectedTableNames, sortedTables],
  );

  const aggregatedSizeBytes = useMemo(() => {
    let total = 0;
    let hasAny = false;
    for (const entry of Object.values(detailsByTable)) {
      if (entry.status !== "loaded") continue;
      const len = entry.details.dataLength;
      if (len != null && len >= 0) {
        total += len;
        hasAny = true;
      }
    }
    return hasAny ? total : null;
  }, [detailsByTable]);

  const headerHostLabel = useMemo(() => {
    const engine = selection.connection.db_type.toLowerCase();
    if (engine === "sqlite" || engine === "sqlite3") {
      return selection.connection.host || selection.connection.database || "—";
    }
    const host = selection.connection.host?.trim() || "—";
    const port = selection.connection.port;
    return port > 0 ? `${host}:${port}` : host;
  }, [selection.connection]);

  const canMysqlIo =
    isMysqlConnectionInfoCapable(selection.connection) &&
    (Boolean(onExportDatabase) || Boolean(onImportDatabase));
  const canCloneSelected =
    selectedNamesOrdered.length > 0 && isCloneTableSqlSupported(selection.connection.db_type);
  const canDeleteSelected =
    selectedNamesOrdered.length > 0 && isSchemaDropSqlSupported(selection.connection.db_type);

  const handleRowClick = useCallback(
    (tableName: string, event: ReactMouseEvent) => {
      const ordered = sortedTables;
      const index = ordered.indexOf(tableName);
      if (index < 0) return;

      if (event.shiftKey && selectionAnchorRef.current) {
        const anchorIndex = ordered.indexOf(selectionAnchorRef.current);
        if (anchorIndex >= 0) {
          const start = Math.min(anchorIndex, index);
          const end = Math.max(anchorIndex, index);
          setSelectedTableNames(new Set(ordered.slice(start, end + 1)));
          return;
        }
      }

      if (event.ctrlKey || event.metaKey) {
        setSelectedTableNames((prev) => {
          const next = new Set(prev);
          if (next.has(tableName)) {
            next.delete(tableName);
          } else {
            next.add(tableName);
          }
          return next;
        });
        selectionAnchorRef.current = tableName;
        return;
      }

      setSelectedTableNames(new Set([tableName]));
      selectionAnchorRef.current = tableName;
    },
    [sortedTables],
  );

  const handleSelectAllRows = useCallback(() => {
    setSelectedTableNames(new Set(sortedTables));
    selectionAnchorRef.current = sortedTables[0] ?? null;
  }, [sortedTables]);

  const handleClearSelection = useCallback(() => {
    setSelectedTableNames(new Set());
    selectionAnchorRef.current = null;
  }, []);

  const handleCopySelectedRows = useCallback(() => {
    const names =
      selectedTableNames.size > 0
        ? sortedTables.filter((name) => selectedTableNames.has(name))
        : selectedTableName
          ? [selectedTableName]
          : [];
    if (names.length === 0) return;
    clipboardTablesRef.current = names;
    void navigator.clipboard.writeText(names.join("\n")).then(
      () => showToast(t("database.tablesPanel.copiedNames", { count: names.length })),
      () => showToast(t("database.tablesPanel.copyFailed")),
    );
  }, [selectedTableName, selectedTableNames, sortedTables, t]);

  const handleCloneTables = useCallback(
    async (sourceNames: string[]) => {
      if (sourceNames.length === 0) return;
      if (!isConnectionEnabled(selection.connection)) {
        showToast(t("database.tablesPanel.connectionDisabled"));
        return;
      }
      if (!isCloneTableSqlSupported(selection.connection.db_type)) {
        showToast(t("database.schemaTree.dropUnsupported"));
        return;
      }

      const existing = new Set(tables);
      let ok = 0;
      let failed = 0;
      for (const source of sourceNames) {
        const target = allocateCloneTableName(source, existing);
        const sql = buildCloneTableSql(
          selection.connection.db_type,
          selection.dbName,
          source,
          target,
        );
        if (!sql) {
          failed += 1;
          continue;
        }
        try {
          await invoke("db_execute_query", {
            connection: { ...selection.connection, database: selection.dbName },
            sql,
            runId: makeQueryRunId(),
            limit: 1,
            offset: 0,
          });
          existing.add(target);
          ok += 1;
        } catch (err) {
          console.error("[tablesPanel.clone] failed", source, err);
          failed += 1;
        }
      }

      try {
        await refreshDatabaseTables();
      } catch (err) {
        console.error("[tablesPanel.clone] refresh failed", err);
      }

      if (ok > 0 && failed === 0) {
        showToast(t("database.tablesPanel.cloneDone", { count: ok }));
      } else if (ok > 0) {
        showToast(t("database.tablesPanel.clonePartial", { ok, failed }));
      } else {
        showToast(t("database.tablesPanel.cloneFailed"));
      }
    },
    [refreshDatabaseTables, selection.connection, selection.dbName, t, tables],
  );

  const handlePasteRows = useCallback(() => {
    const sources = clipboardTablesRef.current.filter((name) => tables.includes(name));
    if (sources.length === 0) {
      showToast(t("database.tablesPanel.pasteEmpty"));
      return;
    }
    void handleCloneTables(sources);
  }, [handleCloneTables, t, tables]);

  const handleDeleteTables = useCallback(
    async (names: string[]) => {
      if (names.length === 0) return;
      if (!isConnectionEnabled(selection.connection)) {
        showToast(t("database.tablesPanel.connectionDisabled"));
        return;
      }
      if (!isSchemaDropSqlSupported(selection.connection.db_type)) {
        showToast(t("database.schemaTree.dropUnsupported"));
        return;
      }

      const label =
        names.length === 1
          ? names[0]!
          : t("database.tablesPanel.deleteManyLabel", { count: names.length });
      const confirmed = await appConfirm(
        t("database.schemaTree.confirmDeleteTable", {
          name: label,
          database: selection.dbName,
        }),
        t("database.schemaTree.confirmDeleteTitle"),
        {
          confirmLabel: t("database.schemaTree.deleteTable"),
          kind: "warning",
        },
      );
      if (!confirmed) return;

      let ok = 0;
      let failed = 0;
      for (const tableName of names) {
        const sql = buildDropTableSql(
          selection.connection.db_type,
          selection.dbName,
          tableName,
        );
        if (!sql) {
          failed += 1;
          continue;
        }
        try {
          await invoke("db_execute_query", {
            connection: { ...selection.connection, database: selection.dbName },
            sql,
            runId: makeQueryRunId(),
            limit: 1,
            offset: 0,
          });
          ok += 1;
        } catch (err) {
          console.error("[tablesPanel.delete] failed", tableName, err);
          failed += 1;
        }
      }

      setSelectedTableNames((prev) => {
        const next = new Set(prev);
        for (const name of names) next.delete(name);
        return next;
      });

      try {
        await refreshDatabaseTables();
      } catch (err) {
        console.error("[tablesPanel.delete] refresh failed", err);
      }

      if (ok > 0 && failed === 0) {
        showToast(t("database.tablesPanel.deleteDone", { count: ok }));
      } else if (ok > 0) {
        showToast(t("database.tablesPanel.deletePartial", { ok, failed }));
      } else {
        showToast(t("database.tablesPanel.deleteFailed"));
      }
    },
    [refreshDatabaseTables, selection.connection, selection.dbName, t],
  );

  const handleRowContextMenu = useCallback(
    (tableName: string, event: ReactMouseEvent) => {
      if (!selectedTableNames.has(tableName)) {
        setSelectedTableNames(new Set([tableName]));
        selectionAnchorRef.current = tableName;
      }
      setContextMenu({ x: event.clientX, y: event.clientY, tableName });
    },
    [selectedTableNames],
  );

  const canDesign = Boolean(onDesignTable) && supportsTableDesign(selection.connection);
  const canOpenTableData = Boolean(onOpenTableData);

  const contextMenuItems = useMemo((): ContextMenuItem[] => {
    if (!contextMenu) return [];
    const targets =
      selectedTableNames.size > 0
        ? sortedTables.filter((name) => selectedTableNames.has(name))
        : [contextMenu.tableName];
    const count = targets.length;
    const single = count === 1 ? targets[0]! : null;
    const canClone = isCloneTableSqlSupported(selection.connection.db_type);
    const canDrop = isSchemaDropSqlSupported(selection.connection.db_type);

    const items: ContextMenuItem[] = [];
    if (single && canOpenTableData) {
      items.push({
        id: "open-data",
        label: t("database.contextMenu.viewTableData"),
        onClick: () => handleOpenTableData(single),
      });
    }
    if (single && canDesign) {
      items.push({
        id: "design",
        label: t("database.contextMenu.designTable"),
        onClick: () => handleDesignTable(single),
      });
    }
    if (single) {
      items.push({
        id: "view-ddl",
        label: t("database.contextMenu.viewDdl"),
        onClick: () => handleOpenDdlDrawer(single),
      });
    }

    items.push({ id: "sep-copy", label: "", separator: true });
    items.push({
      id: "copy",
      label: t("database.contextMenu.copy"),
      children: [
        {
          id: "copy-names",
          label:
            count > 1
              ? t("database.tablesPanel.copyNames", { count })
              : t("database.contextMenu.copyName"),
          onClick: () => {
            clipboardTablesRef.current = targets;
            void navigator.clipboard.writeText(targets.join("\n")).then(
              () => showToast(t("database.tablesPanel.copiedNames", { count })),
              () => showToast(t("database.tablesPanel.copyFailed")),
            );
          },
        },
        ...(single
          ? [
              {
                id: "copy-ddl",
                label: t("database.contextMenu.copyDdl"),
                onClick: () => {
                  void (async () => {
                    try {
                      const cached = readTableDdlCache(
                        selection.connId,
                        selection.dbName,
                        single,
                        selection.connection,
                      );
                      const text =
                        cached ??
                        (await fetchTableDdl(
                          selection.connection,
                          selection.dbName,
                          single,
                        ));
                      await navigator.clipboard.writeText(text);
                      showToast(t("database.contextMenu.copyDdlDone"));
                    } catch {
                      showToast(t("database.contextMenu.copyDdlFailed"));
                    }
                  })();
                },
              } satisfies ContextMenuItem,
            ]
          : []),
      ],
    });

    items.push({ id: "sep-clone", label: "", separator: true });
    items.push({
      id: "clone",
      label: t("database.tablesPanel.cloneTables", { count }),
      disabled: !canClone,
      onClick: () => void handleCloneTables(targets),
    });
    items.push({
      id: "delete",
      label: t("database.tablesPanel.deleteTables", { count }),
      danger: true,
      disabled: !canDrop,
      onClick: () => void handleDeleteTables(targets),
    });

    return items;
  }, [
    canDesign,
    canOpenTableData,
    contextMenu,
    handleCloneTables,
    handleDeleteTables,
    handleDesignTable,
    handleOpenDdlDrawer,
    handleOpenTableData,
    selectedTableNames,
    selection.connId,
    selection.connection,
    selection.dbName,
    sortedTables,
    t,
  ]);

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
  const columnResizeStorageKey = `db-tables-panel-${selection.connId}-${selection.dbName}`;

  const tableColumns = useMemo((): DbTablesPanelGridColumn<string>[] => {
    const cols: DbTablesPanelGridColumn<string>[] = [
      {
        id: "name",
        header: t("database.tablesPanel.columns.name"),
        sortable: true,
        nameCell: true,
        defaultWidth: 220,
        minWidth: 120,
        render: (tableName) => tableName,
        getTitle: (tableName) => tableName,
      },
      {
        id: "comment",
        header: t("database.tablesPanel.details.comment"),
        defaultWidth: 200,
        minWidth: 96,
        render: (tableName) => {
          const entry = detailsByTable[tableName];
          const fallbackComment = tableComments.get(tableName);
          if (entry?.status === "loaded") {
            return displayDetailValue(entry.details.comment ?? fallbackComment ?? null);
          }
          if (fallbackComment) {
            return displayDetailValue(fallbackComment);
          }
          return PLACEHOLDER_CELL;
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
        defaultWidth: 100,
        minWidth: 72,
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
        defaultWidth: 120,
        minWidth: 80,
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
        defaultWidth: 100,
        minWidth: 72,
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
        defaultWidth: 160,
        minWidth: 96,
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
      defaultWidth: canOpenTableData && canDesign ? 108 : canOpenTableData || canDesign ? 84 : 48,
      minWidth: 48,
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
      <div className="db-tables-panel-header">
        <span className="db-tables-panel-header-label">
          {t("database.tablesPanel.headerLabel")}
        </span>
        <div className="db-tables-panel-header-tags">
          <span className="db-tables-panel-header-tag db-tables-panel-header-tag--name" title={selection.dbName}>
            {selection.dbName}
          </span>
          <span
            className="db-tables-panel-header-tag"
            title={t("database.tablesPanel.headerConnection")}
          >
            {selection.connection.name}
          </span>
          <span className="db-tables-panel-header-tag" title={t("database.tablesPanel.details.engine")}>
            {selection.connection.db_type}
          </span>
          <span className="db-tables-panel-header-tag" title={t("database.tablesPanel.headerHost")}>
            {headerHostLabel}
          </span>
          {dbMeta?.charset ? (
            <span className="db-tables-panel-header-tag" title={t("database.tablesPanel.headerCharset")}>
              {dbMeta.charset}
            </span>
          ) : null}
          {dbMeta?.collation ? (
            <span
              className="db-tables-panel-header-tag"
              title={t("database.tablesPanel.details.collation")}
            >
              {dbMeta.collation}
            </span>
          ) : null}
          <span className="db-tables-panel-header-tag" title={t("database.tablesPanel.count", { count: tableCount })}>
            {t("database.tablesPanel.count", { count: tableCount })}
          </span>
          {(dbMeta?.sizeBytes != null && dbMeta.sizeBytes >= 0) || aggregatedSizeBytes != null ? (
            <span className="db-tables-panel-header-tag" title={t("database.tablesPanel.headerSize")}>
              {formatBytes(
                dbMeta?.sizeBytes != null && dbMeta.sizeBytes >= 0
                  ? dbMeta.sizeBytes
                  : aggregatedSizeBytes!,
              )}
            </span>
          ) : null}
        </div>
        <div className="db-tables-panel-header-actions">
          {canCloneSelected ? (
            <Button
              type="button"
              variant="icon"
              size="icon-xs"
              className="db-tables-panel-header-action-btn"
              title={t("database.tablesPanel.cloneTables", { count: selectedNamesOrdered.length })}
              aria-label={t("database.tablesPanel.cloneTables", { count: selectedNamesOrdered.length })}
              onClick={() => void handleCloneTables(selectedNamesOrdered)}
            >
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
                <rect x="5" y="5" width="8" height="8" rx="1.2" />
                <path d="M3 11V3.8A1.2 1.2 0 0 1 4.2 2.6H11" />
              </svg>
            </Button>
          ) : null}
          {canDeleteSelected ? (
            <Button
              type="button"
              variant="icon"
              size="icon-xs"
              className="db-tables-panel-header-action-btn db-tables-panel-header-action-btn--danger"
              title={t("database.tablesPanel.deleteTables", { count: selectedNamesOrdered.length })}
              aria-label={t("database.tablesPanel.deleteTables", { count: selectedNamesOrdered.length })}
              onClick={() => void handleDeleteTables(selectedNamesOrdered)}
            >
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
                <path d="M3.5 4.5h9M6 4.5V3.2h4v1.3M5.2 4.5l.6 8.2h4.4l.6-8.2" />
              </svg>
            </Button>
          ) : null}
          {canMysqlIo && onExportDatabase ? (
            <Button
              type="button"
              variant="icon"
              size="icon-xs"
              className="db-tables-panel-header-action-btn"
              title={t("database.contextMenu.exportDatabase")}
              aria-label={t("database.contextMenu.exportDatabase")}
              disabled={!isConnectionEnabled(selection.connection)}
              onClick={() => onExportDatabase(selection)}
            >
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
                <path d="M8 2.5v7" />
                <path d="M5.5 7 8 9.5 10.5 7" />
                <path d="M3 12.5h10" />
              </svg>
            </Button>
          ) : null}
          {canMysqlIo && onImportDatabase ? (
            <Button
              type="button"
              variant="icon"
              size="icon-xs"
              className="db-tables-panel-header-action-btn"
              title={t("database.contextMenu.importDatabase")}
              aria-label={t("database.contextMenu.importDatabase")}
              disabled={!isConnectionEnabled(selection.connection)}
              onClick={() => onImportDatabase(selection)}
            >
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
                <path d="M8 9.5v-7" />
                <path d="M5.5 5 8 2.5 10.5 5" />
                <path d="M3 12.5h10" />
              </svg>
            </Button>
          ) : null}
          <Button
            type="button"
            variant="icon"
            size="icon-xs"
            className="db-tables-panel-header-action-btn"
            title={t("database.tablesPanel.refreshSchema")}
            aria-label={t("database.tablesPanel.refreshSchema")}
            disabled={schemaRefreshing}
            onClick={() => void refreshDatabaseTables()}
          >
            <svg
              viewBox="0 0 16 16"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              className={schemaRefreshing ? "is-spinning" : undefined}
              aria-hidden
            >
              <path d="M13 8a5 5 0 1 1-1.3-3.4" />
              <path d="M13 3.5V7H9.5" />
            </svg>
          </Button>
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
                selectedRowKeys={selectedTableNames}
                onRowClick={handleRowClick}
                onRowDoubleClick={(tableName) => {
                  if (canOpenTableData) {
                    handleOpenTableData(tableName);
                  }
                }}
                onRowContextMenu={handleRowContextMenu}
                onSelectAllRows={handleSelectAllRows}
                onClearSelection={handleClearSelection}
                onCopySelectedRows={handleCopySelectedRows}
                onPasteRows={handlePasteRows}
                onDeleteSelectedRows={() => {
                  const names = sortedTables.filter((name) => selectedTableNames.has(name));
                  void handleDeleteTables(names);
                }}
                onActivateSelectedRows={() => {
                  if (canOpenTableData && selectedTableName) {
                    handleOpenTableData(selectedTableName);
                  }
                }}
                virtualizeRows
                columnResizeStorageKey={columnResizeStorageKey}
              />
            )}
            {cacheReady && tableCount > 0 && filteredTables.length === 0 && (
              <div className="db-tables-panel-empty">{t("database.tablesPanel.noResults")}</div>
            )}
          </div>
          {contextMenu ? (
            <ContextMenu
              position={{ x: contextMenu.x, y: contextMenu.y }}
              onClose={() => setContextMenu(null)}
              items={contextMenuItems}
            />
          ) : null}
        </div>
      </div>

      <div className="db-tables-panel-meta">
        <DbPanelMetaRefreshButton
          onClick={() => void handleRefreshDetails()}
          disabled={!cacheReady || tables.length === 0}
          busy={detailsRefreshing}
        />
        <div className="db-tables-panel-meta-actions">
          {canDesign ? (
            <Button
              variant="ghost"
              size="xs"
              className="db-tables-panel-meta-btn"
              onClick={handleNewTable}
            >
              {t("database.tablesPanel.newTable")}
            </Button>
          ) : null}
          <TextInput
            ref={searchInputRef}
            className="db-tables-panel-search-input db-tables-panel-search-input--meta"
            value={search}
            onChange={setSearch}
            placeholder={t("database.tablesPanel.search")}
            clearable
            copyable={false}
            spellCheck={false}
            autoComplete="off"
          />
        </div>
        <span
          className="db-tables-panel-meta-text"
          title={canOpenTableData ? t("database.tablesPanel.openHint") : undefined}
        >
          {!cacheReady
            ? t("database.tablesPanel.cacheEmpty")
            : detailsRefreshing
              ? t("common.loading")
              : selectedTableNames.size > 0
                ? `${t("database.tablesPanel.count", { count: tableCount })} · ${t("database.tablesPanel.selectedCount", { count: selectedTableNames.size })}`
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
