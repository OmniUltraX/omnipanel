import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "../../i18n";
import { textSearchMatches } from "../../lib/textSearchMatch";
import { ScopedSearch } from "../../components/ui/ScopedSearch";
import { DockHandle, DockLayout, DockPanel } from "../../components/dock";
import { fetchTableDdl } from "./api";
import { formatSqlDdl } from "./formatSqlDdl";
import type { SchemaDatabaseSelection, SchemaTableSelection } from "./SchemaBrowser";
import { TableDdlViewer } from "./TableDdlViewer";
import { useDbSchemaCacheStore } from "../../stores/dbSchemaCacheStore";
import {
  buildTableNameTree,
  collectTableTreeFolderKeys,
  countTableTreeLeaves,
  filterTableNameTree,
  type TableNameTreeNode,
} from "./buildTableNameTree";
import { getCachedTableCommentMap, getCachedTableNames } from "./schemaCacheMerge";

interface DatabaseTablesPanelProps {
  selection: SchemaDatabaseSelection;
  onSelectTable: (selection: SchemaTableSelection) => void;
}

type TablesPanelViewMode = "tree" | "list";

const VIEW_MODE_STORAGE_KEY = "database-tables-panel-view";

function readStoredViewMode(): TablesPanelViewMode {
  try {
    const stored = localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    if (stored === "tree" || stored === "list") {
      return stored;
    }
  } catch {
    // ignore storage errors
  }
  return "tree";
}

function TableNameRow({
  tableName,
  depth,
  selected,
  onPreviewTable,
  onOpenTable,
  tableComments,
}: {
  tableName: string;
  depth: number;
  selected: boolean;
  onPreviewTable: (tableName: string) => void;
  onOpenTable: (tableName: string) => void;
  tableComments: ReadonlyMap<string, string>;
}) {
  const comment = tableComments.get(tableName);
  return (
    <button
      type="button"
      className={`db-tables-panel-item db-tables-panel-tree-table${selected ? " is-selected" : ""}`}
      style={{ paddingLeft: depth * 16 + 8 }}
      onClick={() => onPreviewTable(tableName)}
      onDoubleClick={() => onOpenTable(tableName)}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="13" height="13" aria-hidden>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M3 9h18M3 15h18M9 3v18" />
      </svg>
      <span
        className="db-tables-panel-item-name"
        title={comment ? `${tableName} — ${comment}` : tableName}
      >
        {tableName}
        {comment ? (
          <span className="db-tables-panel-item-comment" title={comment}>
            {comment}
          </span>
        ) : null}
      </span>
    </button>
  );
}

function TableNameTreeBranch({
  node,
  depth,
  expandedFolders,
  onToggleFolder,
  previewTableName,
  onPreviewTable,
  onOpenTable,
  tableComments,
}: {
  node: TableNameTreeNode;
  depth: number;
  expandedFolders: Set<string>;
  onToggleFolder: (key: string) => void;
  previewTableName: string | null;
  onPreviewTable: (tableName: string) => void;
  onOpenTable: (tableName: string) => void;
  tableComments: ReadonlyMap<string, string>;
}) {
  if (node.kind === "folder") {
    const expanded = expandedFolders.has(node.key);
    const childCount = countTableTreeLeaves(node);
    return (
      <>
        <button
          type="button"
          className="db-tables-panel-tree-folder"
          style={{ paddingLeft: depth * 16 + 8 }}
          onClick={() => onToggleFolder(node.key)}
        >
          <span className={`tree-arrow${expanded ? " tree-arrow--open" : ""}`}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="10" height="10">
              <path d="M9 18l6-6-6-6" />
            </svg>
          </span>
          <span className="db-tables-panel-tree-folder-name">{node.segment}</span>
          <span className="db-tables-panel-tree-folder-count">{childCount}</span>
        </button>
        {expanded &&
          node.children.map((child) => (
            <TableNameTreeBranch
              key={child.key}
              node={child}
              depth={depth + 1}
              expandedFolders={expandedFolders}
              onToggleFolder={onToggleFolder}
              previewTableName={previewTableName}
              onPreviewTable={onPreviewTable}
              onOpenTable={onOpenTable}
              tableComments={tableComments}
            />
          ))}
      </>
    );
  }

  const selected = previewTableName === node.tableName;
  return (
    <TableNameRow
      tableName={node.tableName}
      depth={depth}
      selected={selected}
      onPreviewTable={onPreviewTable}
      onOpenTable={onOpenTable}
      tableComments={tableComments}
    />
  );
}

export function DatabaseTablesPanel({
  selection,
  onSelectTable,
}: DatabaseTablesPanelProps) {
  const { t } = useI18n();
  const hydrateSchemaCache = useDbSchemaCacheStore((s) => s.hydrate);
  const cacheHydrated = useDbSchemaCacheStore((s) => s.hydrated);
  const schemaSnapshot = useDbSchemaCacheStore((s) => s.snapshot);
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<TablesPanelViewMode>(readStoredViewMode);
  const [previewTableName, setPreviewTableName] = useState<string | null>(null);
  const [ddl, setDdl] = useState("");
  const [ddlLoading, setDdlLoading] = useState(false);
  const [ddlError, setDdlError] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!cacheHydrated) {
      void hydrateSchemaCache();
    }
  }, [cacheHydrated, hydrateSchemaCache]);

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_MODE_STORAGE_KEY, viewMode);
    } catch {
      // ignore storage errors
    }
  }, [viewMode]);

  useEffect(() => {
    setSearch("");
    setPreviewTableName(null);
    setDdl("");
    setDdlError(null);
    setExpandedFolders(new Set());
  }, [selection.connId, selection.dbName]);

  const tables = useMemo(
    () => getCachedTableNames(schemaSnapshot, selection.connId, selection.dbName),
    [schemaSnapshot, selection.connId, selection.dbName],
  );

  const tableComments = useMemo(
    () => getCachedTableCommentMap(schemaSnapshot, selection.connId, selection.dbName),
    [schemaSnapshot, selection.connId, selection.dbName],
  );

  const filteredTree = useMemo(() => {
    const tree = buildTableNameTree(tables);
    return filterTableNameTree(tree, search, tableComments);
  }, [search, tables, tableComments]);

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

  useEffect(() => {
    if (!search.trim() || viewMode !== "tree") {
      return;
    }
    setExpandedFolders(new Set(collectTableTreeFolderKeys(filteredTree)));
  }, [search, filteredTree, viewMode]);

  useEffect(() => {
    if (!previewTableName) {
      setDdl("");
      setDdlError(null);
      setDdlLoading(false);
      return;
    }

    let cancelled = false;
    setDdlLoading(true);
    setDdlError(null);
    setDdl("");

    void fetchTableDdl(selection.connection, selection.dbName, previewTableName)
      .then((raw) => {
        if (cancelled) {
          return;
        }
        setDdl(formatSqlDdl(raw, selection.connection.db_type));
      })
      .catch((err) => {
        if (cancelled) {
          return;
        }
        setDdlError(String(err));
      })
      .finally(() => {
        if (!cancelled) {
          setDdlLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [previewTableName, selection.connection, selection.dbName]);

  const handlePreviewTable = useCallback((tableName: string) => {
    setPreviewTableName(tableName);
  }, []);

  const handleOpenTable = useCallback(
    (tableName: string) => {
      onSelectTable({
        connId: selection.connId,
        dbName: selection.dbName,
        tableName,
        connection: selection.connection,
      });
    },
    [onSelectTable, selection.connId, selection.dbName, selection.connection],
  );

  const toggleFolder = useCallback((key: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

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

  return (
    <ScopedSearch
      className="db-tables-panel db-tables-panel--dock"
      value={search}
      onChange={setSearch}
      placeholder={t("database.tablesPanel.search")}
    >
      <div className="db-tables-panel-body">
        <DockLayout direction="horizontal" className="db-tables-panel-split">
          <DockPanel defaultSize="40%" minSize="20%" maxSize="75%" className="db-tables-panel-list-pane">
            <div className="db-tables-panel-list">
              {!cacheReady && (
                <div className="db-tables-panel-empty">{t("database.tablesPanel.cacheEmptyHint")}</div>
              )}
              {cacheReady && tableCount === 0 && (
                <div className="db-tables-panel-empty">{t("database.sidebar.noTables")}</div>
              )}
              {cacheReady &&
                viewMode === "tree" &&
                filteredTree.map((node) => (
                  <TableNameTreeBranch
                    key={node.key}
                    node={node}
                    depth={0}
                    expandedFolders={expandedFolders}
                    onToggleFolder={toggleFolder}
                    previewTableName={previewTableName}
                    onPreviewTable={handlePreviewTable}
                    onOpenTable={handleOpenTable}
                    tableComments={tableComments}
                  />
                ))}
              {cacheReady &&
                viewMode === "list" &&
                filteredTables.map((tableName) => (
                  <TableNameRow
                    key={tableName}
                    tableName={tableName}
                    depth={0}
                    selected={previewTableName === tableName}
                    onPreviewTable={handlePreviewTable}
                    onOpenTable={handleOpenTable}
                    tableComments={tableComments}
                  />
                ))}
            </div>
          </DockPanel>
          <DockHandle direction="horizontal" />
          <DockPanel defaultSize="60%" minSize="25%" className="db-tables-panel-ddl-pane">
            <div className="db-tables-panel-ddl">
              {!previewTableName ? (
                <div className="db-tables-panel-ddl-empty">
                  {t("database.tablesPanel.ddlEmpty")}
                </div>
              ) : (
                <>
                  <div className="db-tables-panel-ddl-header">
                    <span className="db-tables-panel-ddl-title">{previewTableName}</span>
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
          </DockPanel>
        </DockLayout>
      </div>

      <div className="db-tables-panel-meta">
        <div className="db-tables-panel-view-toggle" role="group" aria-label={t("database.tablesPanel.viewMode")}>
          <button
            type="button"
            className={`db-tables-panel-view-btn${viewMode === "tree" ? " is-active" : ""}`}
            title={t("database.tablesPanel.viewTree")}
            aria-pressed={viewMode === "tree"}
            onClick={() => setViewMode("tree")}
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
              <path d="M2 3h12M2 8h8M2 13h10" />
            </svg>
          </button>
          <button
            type="button"
            className={`db-tables-panel-view-btn${viewMode === "list" ? " is-active" : ""}`}
            title={t("database.tablesPanel.viewList")}
            aria-pressed={viewMode === "list"}
            onClick={() => setViewMode("list")}
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
              <path d="M2 4h12M2 8h12M2 12h12" />
            </svg>
          </button>
        </div>
        <span className="db-tables-panel-meta-text">
          {!cacheReady
            ? t("database.tablesPanel.cacheEmpty")
            : t("database.tablesPanel.count", { count: tableCount })}
        </span>
      </div>
    </ScopedSearch>
  );
}
