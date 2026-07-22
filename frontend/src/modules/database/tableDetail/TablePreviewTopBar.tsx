import { Button } from "../../../components/ui/Button";
import { IconPlus } from "../../../components/ui/Icons";
import { useI18n } from "../../../i18n";

export interface TablePreviewTopBarProps {
  loading: boolean;
  page: number;
  pageSize: number;
  totalRows: number;
  totalPages: number;
  dirtyCount: number;
  isCommitting: boolean;
  canUndoDirty: boolean;
  canRedoDirty: boolean;
  canInsertRow: boolean;
  canDeleteRow: boolean;
  hasSelectedRows: boolean;
  selectedRowCount: number;
  canExport: boolean;
  canDesignTable: boolean;
  canCreateTableQuery: boolean;
  transposed: boolean;
  detailCollapsed: boolean;
  colSidebarCollapsed: boolean;
  onPageChange: (page: number) => void;
  onRefresh: () => void;
  onInsertRow: () => void;
  onDeleteSelectedRows: () => void;
  onUndoAll: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onCommit: () => void;
  /** 工具栏悬停提示中的快捷键文案，如 "Ctrl+S" */
  saveShortcutHint?: string;
  undoShortcutHint?: string;
  redoShortcutHint?: string;
  onExport: (clientX: number, clientY: number) => void;
  onTransposeToggle: () => void;
  onToggleColSidebar: () => void;
  onToggleDetail: () => void;
  /** 查看表 DDL（右侧面板） */
  ddlOpen?: boolean;
  canShowDdl?: boolean;
  onToggleDdl?: () => void;
  onOpenTableDesign?: () => void;
  onCreateTableQuery?: () => void;
  onCopyPreviewSql?: () => void;
  copySqlHint?: boolean;
  previewSqlTitle?: string;
}

function IconRefresh() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14" aria-hidden>
      <path d="M13 3.5v3h-3M3 12.5v-3h3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4.2 6A5 5 0 0 1 12.5 5.2M11.8 10A5 5 0 0 1 3.5 10.8" strokeLinecap="round" />
    </svg>
  );
}

function IconTrash() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14" aria-hidden>
      <path d="M3 4.5h10M6 4.5V3.25A1.25 1.25 0 0 1 7.25 2h1.5A1.25 1.25 0 0 1 10 3.25V4.5" strokeLinecap="round" />
      <path d="M5.25 4.5l.5 8.25A1.25 1.25 0 0 0 7 14h2a1.25 1.25 0 0 0 1.25-1.25l.5-8.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" width="14" height="14" aria-hidden>
      <path d="M3.5 8.5l3 3 6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconDownload() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14" aria-hidden>
      <path d="M8 2.5v8" strokeLinecap="round" />
      <path d="M5 8l3 3 3-3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 13h10" strokeLinecap="round" />
    </svg>
  );
}

function IconUndoAll() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14" aria-hidden>
      <path d="M4.5 3.5 2.5 5.5 4.5 7.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2.5 5.5h6.2a4.3 4.3 0 1 1 0 8.6H5" strokeLinecap="round" />
      <path d="M9.5 3.5 13 7M13 3.5 9.5 7" strokeLinecap="round" />
    </svg>
  );
}

function IconUndo() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14" aria-hidden>
      <path d="M5 3.5 2.5 6 5 8.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2.5 6h6.5a4 4 0 1 1 0 8H7" strokeLinecap="round" />
    </svg>
  );
}

function IconRedo() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14" aria-hidden>
      <path d="M11 3.5 13.5 6 11 8.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13.5 6H7a4 4 0 1 0 0 8h2" strokeLinecap="round" />
    </svg>
  );
}

/** 设计表：表格网格 */
function IconDesignTable() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14" aria-hidden>
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <path d="M2 6h12M2 9.5h12M6.5 6v7.5M10.5 6v7.5" />
    </svg>
  );
}

/** 新建查询：SQL 文档 + 加号 */
function IconNewQuery() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14" aria-hidden>
      <path d="M4 2.5h5.5L12.5 5.5V13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1Z" strokeLinejoin="round" />
      <path d="M9 2.5V5.5h3" strokeLinejoin="round" />
      <path d="M5.5 9h2M5.5 11.5h4" strokeLinecap="round" />
      <path d="M12.5 9.5v3M11 11h3" strokeLinecap="round" />
    </svg>
  );
}

/** 查看 DDL：代码文档 */
function IconDdl() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14" aria-hidden>
      <path d="M4 2.5h5.5L12.5 5.5V13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1Z" strokeLinejoin="round" />
      <path d="M9 2.5V5.5h3" strokeLinejoin="round" />
      <path d="M5.5 9h1.5M5.5 11.5H9" strokeLinecap="round" />
      <path d="M10.5 9.25 12 10.75 10.5 12.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function TablePreviewTopBar({
  loading,
  page,
  pageSize,
  totalRows,
  totalPages,
  dirtyCount,
  isCommitting,
  canUndoDirty,
  canRedoDirty,
  canInsertRow,
  canDeleteRow,
  hasSelectedRows,
  selectedRowCount,
  canExport,
  canDesignTable,
  canCreateTableQuery,
  transposed,
  detailCollapsed,
  colSidebarCollapsed,
  onPageChange,
  onRefresh,
  onInsertRow,
  onDeleteSelectedRows,
  onUndoAll,
  onUndo,
  onRedo,
  onCommit,
  saveShortcutHint,
  undoShortcutHint,
  redoShortcutHint,
  onExport,
  onTransposeToggle,
  onToggleColSidebar,
  onToggleDetail,
  ddlOpen = false,
  canShowDdl = false,
  onToggleDdl,
  onOpenTableDesign,
  onCreateTableQuery,
  onCopyPreviewSql,
  copySqlHint,
  previewSqlTitle,
}: TablePreviewTopBarProps) {
  const { t } = useI18n();
  const showingFrom = totalRows === 0 ? 0 : page * pageSize + 1;
  const showingTo = Math.min((page + 1) * pageSize, totalRows);
  const canDiscard = dirtyCount > 0 && !isCommitting;
  const undoTitle = undoShortcutHint
    ? `${t("database.results.undo")} (${undoShortcutHint})`
    : t("database.results.undo");
  const redoTitle = redoShortcutHint
    ? `${t("database.results.redo")} (${redoShortcutHint})`
    : t("database.results.redo");
  const commitTitle = saveShortcutHint
    ? `${t("database.results.commitDirty", { count: dirtyCount })} (${saveShortcutHint})`
    : t("database.results.commitDirty", { count: dirtyCount });

  return (
    <div className="db-table-topbar">
      <div className="db-table-topbar-group">
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={page <= 0 || loading}
          onClick={() => onPageChange(0)}
          title={t("database.results.paginationFirst")}
          aria-label={t("database.results.paginationFirst")}
        >
          «
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={page <= 0 || loading}
          onClick={() => onPageChange(page - 1)}
          title={t("database.results.paginationPrev")}
          aria-label={t("database.results.paginationPrev")}
        >
          ‹
        </Button>
        <span className="db-table-topbar-page">
          {page + 1} / {totalPages}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={page >= totalPages - 1 || loading}
          onClick={() => onPageChange(page + 1)}
          title={t("database.results.paginationNext")}
          aria-label={t("database.results.paginationNext")}
        >
          ›
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={page >= totalPages - 1 || loading}
          onClick={() => onPageChange(totalPages - 1)}
          title={t("database.results.paginationLast")}
          aria-label={t("database.results.paginationLast")}
        >
          »
        </Button>
        <span className="db-table-topbar-range">
          {loading && totalRows === 0
            ? t("common.loading")
            : totalRows > 0
              ? `${showingFrom.toLocaleString()}–${showingTo.toLocaleString()} / ${totalRows.toLocaleString()}`
              : "0"}
        </span>
      </div>

      <div className="db-table-topbar-group db-table-topbar-group--actions">
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={loading}
          title={t("common.refresh")}
          aria-label={t("common.refresh")}
          onClick={onRefresh}
        >
          <IconRefresh />
        </Button>
        {canInsertRow ? (
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={loading}
            title={t("database.rowEditor.newRow")}
            aria-label={t("database.rowEditor.newRow")}
            onClick={onInsertRow}
          >
            <IconPlus size={14} />
          </Button>
        ) : null}
        {canDeleteRow ? (
          <span className="db-toolbar-icon-button-wrap">
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={!hasSelectedRows || loading}
              title={
                hasSelectedRows
                  ? t("database.results.deleteSelectedRows", { count: selectedRowCount })
                  : t("database.results.deleteSelectedRowsDisabled")
              }
              aria-label={
                hasSelectedRows
                  ? t("database.results.deleteSelectedRows", { count: selectedRowCount })
                  : t("database.results.deleteSelectedRowsDisabled")
              }
              onClick={onDeleteSelectedRows}
            >
              <IconTrash />
            </Button>
            {hasSelectedRows ? (
              <span className="db-delete-selected-rows-badge">{selectedRowCount}</span>
            ) : null}
          </span>
        ) : null}
        <span className="db-table-topbar-undo-group" role="group" aria-label={t("database.results.undoGroup")}>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={!canDiscard}
            title={t("database.results.undoAll")}
            aria-label={t("database.results.undoAll")}
            onClick={onUndoAll}
          >
            <IconUndoAll />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={!canUndoDirty || isCommitting}
            title={undoTitle}
            aria-label={undoTitle}
            onClick={onUndo}
          >
            <IconUndo />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={!canRedoDirty || isCommitting}
            title={redoTitle}
            aria-label={redoTitle}
            onClick={onRedo}
          >
            <IconRedo />
          </Button>
        </span>
        <span className="db-toolbar-icon-button-wrap">
          <Button
            variant={dirtyCount > 0 ? "primary" : "ghost"}
            size="icon-sm"
            disabled={dirtyCount === 0 || isCommitting}
            title={commitTitle}
            aria-label={commitTitle}
            onClick={onCommit}
          >
            <IconCheck />
          </Button>
          {dirtyCount > 0 && !isCommitting ? (
            <span className="db-toolbar-badge" aria-hidden>
              {dirtyCount}
            </span>
          ) : null}
        </span>
      </div>

      <div className="db-table-topbar-group db-table-topbar-group--end">
        <Button
          variant={!colSidebarCollapsed ? "default" : "ghost"}
          size="icon-sm"
          title={
            colSidebarCollapsed
              ? t("database.results.columnVisibilityExpand")
              : t("database.results.columnVisibilityCollapse")
          }
          aria-label={
            colSidebarCollapsed
              ? t("database.results.columnVisibilityExpand")
              : t("database.results.columnVisibilityCollapse")
          }
          aria-expanded={!colSidebarCollapsed}
          onClick={onToggleColSidebar}
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14" aria-hidden>
            <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
            <path d="M5 2.5v11" />
          </svg>
        </Button>
        <Button
          variant={transposed ? "default" : "ghost"}
          size="icon-sm"
          title={transposed ? t("database.results.transposeOff") : t("database.results.transposeOn")}
          aria-label={transposed ? t("database.results.transposeOff") : t("database.results.transposeOn")}
          aria-pressed={transposed}
          onClick={onTransposeToggle}
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14" aria-hidden>
            <rect x="1.5" y="1.5" width="5" height="5" rx="0.75" />
            <rect x="9.5" y="9.5" width="5" height="5" rx="0.75" />
            <path d="M6.5 4h3M4 6.5v3M12 9.5v3M9.5 12h3" strokeLinecap="round" />
          </svg>
        </Button>
        {onCopyPreviewSql ? (
          <Button
            variant={copySqlHint ? "default" : "ghost"}
            size="icon-sm"
            title={copySqlHint ? t("database.results.copyPreviewSqlDone") : previewSqlTitle}
            aria-label={t("database.results.copyPreviewSql")}
            onClick={onCopyPreviewSql}
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14" aria-hidden>
              <rect x="5" y="5" width="8" height="9" rx="1" />
              <path d="M4 11V3.5A1.5 1.5 0 0 1 5.5 2H11" strokeLinecap="round" />
            </svg>
          </Button>
        ) : null}
        {onOpenTableDesign ? (
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={!canDesignTable || loading}
            title={t("database.contextMenu.designTable")}
            aria-label={t("database.contextMenu.designTable")}
            onClick={onOpenTableDesign}
          >
            <IconDesignTable />
          </Button>
        ) : null}
        {onCreateTableQuery ? (
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={!canCreateTableQuery || loading}
            title={t("database.workspace.newQuery")}
            aria-label={t("database.workspace.newQuery")}
            onClick={onCreateTableQuery}
          >
            <IconNewQuery />
          </Button>
        ) : null}
        {canExport ? (
          <Button
            variant="ghost"
            size="icon-sm"
            title={t("database.results.exportCsv")}
            aria-label={t("database.results.exportCsv")}
            onClick={(e) => onExport(e.clientX, e.clientY)}
          >
            <IconDownload />
          </Button>
        ) : null}
        {canShowDdl && onToggleDdl ? (
          <Button
            variant={ddlOpen ? "default" : "ghost"}
            size="icon-sm"
            disabled={loading}
            title={ddlOpen ? t("database.results.ddlCollapse") : t("database.results.ddlExpand")}
            aria-label={ddlOpen ? t("database.results.ddlCollapse") : t("database.results.ddlExpand")}
            aria-pressed={ddlOpen}
            aria-expanded={ddlOpen}
            onClick={onToggleDdl}
          >
            <IconDdl />
          </Button>
        ) : null}
        <Button
          variant={!detailCollapsed ? "default" : "ghost"}
          size="icon-sm"
          title={
            detailCollapsed
              ? t("database.results.cellEditorExpand")
              : t("database.results.cellEditorCollapse")
          }
          aria-label={
            detailCollapsed
              ? t("database.results.cellEditorExpand")
              : t("database.results.cellEditorCollapse")
          }
          aria-expanded={!detailCollapsed}
          onClick={onToggleDetail}
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14" aria-hidden>
            <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
            <path d="M10 2.5v11" />
          </svg>
        </Button>
      </div>
    </div>
  );
}
