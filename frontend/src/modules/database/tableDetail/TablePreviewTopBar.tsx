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
  onCommit: () => void;
  onExport: (clientX: number, clientY: number) => void;
  onTransposeToggle: () => void;
  onToggleColSidebar: () => void;
  onToggleDetail: () => void;
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

export function TablePreviewTopBar({
  loading,
  page,
  pageSize,
  totalRows,
  totalPages,
  dirtyCount,
  isCommitting,
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
  onCommit,
  onExport,
  onTransposeToggle,
  onToggleColSidebar,
  onToggleDetail,
  onOpenTableDesign,
  onCreateTableQuery,
  onCopyPreviewSql,
  copySqlHint,
  previewSqlTitle,
}: TablePreviewTopBarProps) {
  const { t } = useI18n();
  const showingFrom = totalRows === 0 ? 0 : page * pageSize + 1;
  const showingTo = Math.min((page + 1) * pageSize, totalRows);

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
        <span className="db-toolbar-icon-button-wrap">
          <Button
            variant={dirtyCount > 0 ? "primary" : "ghost"}
            size="icon-sm"
            disabled={dirtyCount === 0 || isCommitting}
            title={t("database.results.commitDirty", { count: dirtyCount })}
            aria-label={t("database.results.commitDirty", { count: dirtyCount })}
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
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14" aria-hidden>
              <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
              <path d="M5 8h6M8 5v6" />
            </svg>
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
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14" aria-hidden>
              <path d="M3 4.5h10M3 8h10M3 11.5h6" strokeLinecap="round" />
              <path d="M11.5 8.5 13 10l-2 2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
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
