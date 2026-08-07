import { memo, useCallback, useMemo, useRef, useState } from "react";
import { useSettingsStore } from "../../../stores/settingsStore";
import { useDbWorkspace } from "../../../contexts/DbWorkspaceContext";
import { Button } from "../../../components/ui/primitives/Button";
import { TableDataGrid, type TableDataGridActiveCell, type TableDataGridActions } from "../grid/TableDataGrid";
import { selectionTargetKey, selectionTargetsKey } from "../grid/tableDataGridSelection";
import { parseOmniBlobValue } from "../grid/omniBlobValue";
import { useI18n } from "../../../i18n";
import { estimateSqlResultTotalRows, type SqlResultSession } from "../workspace/dbWorkspaceState";
import type { MutableRefObject } from "react";
import { ImportToTableDialog, type ImportToTableDialogPayload } from "./ImportToTableDialog";
import { useDbWorkspaceTabStore } from "../../../stores/dbWorkspaceTabStore";

export interface SqlResultSessionPanelProps {
  sqlTabId: string;
  session: SqlResultSession;
  /** 详情面板是否收起（影响 Escape 保留选区等） */
  detailCollapsed?: boolean;
  /** 是否向父级上报选区（仅当前激活 Result 会话） */
  selectionReporting?: boolean;
  gridActionsRef?: MutableRefObject<TableDataGridActions | null>;
  onActiveCellChange?: (cell: TableDataGridActiveCell | null) => void;
  onSelectedCellsChange?: (cells: TableDataGridActiveCell[]) => void;
  onCellEditorFocusRequest?: () => void;
  onRowBandSelect?: () => void;
}

/** 从单元格值推断预览类型（SQL 结果通常没有完整 columnMeta） */
export function inferSqlResultColumnType(column: string, value: unknown): string {
  const blob = parseOmniBlobValue(value);
  if (blob) {
    if (blob.kind === "text") return blob.mime?.includes("json") ? "json" : "longtext";
    if (blob.kind === "image" || blob.kind === "audio" || blob.kind === "binary") {
      return "blob";
    }
  }
  if (value !== null && typeof value === "object") return "json";
  if (typeof value === "number") return "decimal";
  if (typeof value === "boolean") return "boolean";
  void column;
  return "text";
}

function SqlResultSessionFooterExtra({
  session,
  sqlTabId,
  canExport,
  onImportToTable,
}: {
  session: SqlResultSession;
  sqlTabId: string;
  canExport: boolean;
  onImportToTable?: () => void;
}) {
  const { t } = useI18n();
  const ws = useDbWorkspace();

  return (
    <>
      {canExport ? (
        <Button
          variant="icon"
          title={t("database.results.exportCsv")}
          aria-label={t("database.results.exportCsv")}
          disabled={session.running}
          onClick={(e) => {
            ws.openExportMenu(e.clientX, e.clientY, sqlTabId, session.id);
          }}
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            width="14"
            height="14"
            aria-hidden
          >
            <path d="M8 1.5v9" strokeLinecap="round" />
            <path d="M4.5 7L8 10.5 11.5 7" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M2.5 13h11" strokeLinecap="round" />
          </svg>
        </Button>
      ) : null}
      {canExport && onImportToTable ? (
        <Button
          variant="icon"
          title={t("database.results.importToTable.button")}
          aria-label={t("database.results.importToTable.button")}
          disabled={session.running}
          onClick={onImportToTable}
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            width="14"
            height="14"
            aria-hidden
          >
            <path d="M8 14.5v-9" strokeLinecap="round" />
            <path d="M4.5 9L8 5.5 11.5 9" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M2.5 3h11" strokeLinecap="round" />
            <path d="M3.5 12.5h9" strokeLinecap="round" />
          </svg>
        </Button>
      ) : null}
    </>
  );
}

export const SqlResultSessionPanel = memo(function SqlResultSessionPanel({
  sqlTabId,
  session,
  detailCollapsed = true,
  selectionReporting = false,
  gridActionsRef,
  onActiveCellChange,
  onSelectedCellsChange,
  onCellEditorFocusRequest,
  onRowBandSelect,
}: SqlResultSessionPanelProps) {
  const { t } = useI18n();
  const ws = useDbWorkspace();
  const databaseQueryPageSize = useSettingsStore((s) => s.databaseQueryPageSize);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importPayload, setImportPayload] = useState<ImportToTableDialogPayload | null>(null);

  const activeCellRef = useRef<TableDataGridActiveCell | null>(null);
  const selectedCellsKeyRef = useRef<string | undefined>(undefined);

  const resultRows = session.result
    ? ws.rowsToRecord(session.result.columns, session.result.rows)
    : [];
  const rowCount = resultRows.length;
  const columns = session.result?.columns ?? [];

  const resultPage = session.resultPage ?? 0;
  const resultHasMore = session.resultHasMore ?? false;
  const estimatedTotalRows = estimateSqlResultTotalRows(
    resultPage,
    databaseQueryPageSize,
    rowCount,
    resultHasMore,
  );

  const hasSqlResult = !!(session.result && session.result.columns.length > 0);
  const canExport = hasSqlResult;

  const handleQueryPageChange = useCallback(
    (page: number) => {
      if (session.running) return;
      void ws.goToQueryResultPage(sqlTabId, page, session.id);
    },
    [session.running, ws.goToQueryResultPage, sqlTabId, session.id],
  );

  const openImportToTable = useCallback(() => {
    if (!session.result || session.result.columns.length === 0) return;
    const conn =
      ws.connectionForSqlTab(sqlTabId, session.sql) ??
      ws.resolveSqlTabConnection(sqlTabId);
    if (!conn) return;
    const tabState = useDbWorkspaceTabStore.getState().sqlTabStates[sqlTabId];
    setImportPayload({
      sourceConnection: conn,
      sourceSql: session.sql.trim(),
      sourceColumns: session.result.columns,
      currentPageRows: session.result.rows.length,
      resultHasMore,
      defaultConnId: conn.id,
      defaultDatabase: tabState?.database ?? conn.database ?? null,
    });
    setImportDialogOpen(true);
  }, [resultHasMore, session.result, session.sql, sqlTabId, ws]);

  const footerExtra = useMemo(
    () => (
      <SqlResultSessionFooterExtra
        session={session}
        sqlTabId={sqlTabId}
        canExport={canExport}
        onImportToTable={canExport ? openImportToTable : undefined}
      />
    ),
    [session, sqlTabId, canExport, openImportToTable],
  );

  const showStandaloneFooter =
    !session.running &&
    (session.error != null || (session.result != null && session.result.columns.length === 0));

  const handleActiveCellChange = useCallback(
    (cell: TableDataGridActiveCell | null) => {
      if (!selectionReporting) return;
      const prevKey = selectionTargetKey(activeCellRef.current);
      const nextKey = selectionTargetKey(cell);
      if (prevKey === nextKey) return;
      activeCellRef.current = cell;
      onActiveCellChange?.(cell);
    },
    [selectionReporting, onActiveCellChange],
  );

  const handleSelectedCellsChange = useCallback(
    (cells: TableDataGridActiveCell[]) => {
      if (!selectionReporting) return;
      const nextKey = selectionTargetsKey(cells);
      if (nextKey === selectedCellsKeyRef.current) return;
      selectedCellsKeyRef.current = nextKey;
      onSelectedCellsChange?.(cells);
    },
    [selectionReporting, onSelectedCellsChange],
  );

  // 首次执行才显示「执行中」；翻页时保留上一页表格，避免闪烁
  if (session.running && !session.result && !session.error) {
    return (
      <div className="db-sql-result-session">
        <div className="empty-state compact" style={{ padding: "var(--sp-4)" }}>
          {t("database.running")}
        </div>
      </div>
    );
  }

  if (session.error && !session.result) {
    return (
      <div className="db-sql-result-session">
        <div
          className="empty-state compact text-danger"
          style={{ padding: "var(--sp-4)", whiteSpace: "pre-wrap" }}
        >
          {session.error}
        </div>
        {showStandaloneFooter ? (
          <div className="db-pagination db-sql-results-footer">
            <div className="db-pagination-extra">{footerExtra}</div>
          </div>
        ) : null}
      </div>
    );
  }

  if (!session.result) {
    return (
      <div className="db-sql-result-session">
        <div className="empty-state compact" style={{ padding: "var(--sp-4)" }}>
          {t("database.results.runHint")}
        </div>
      </div>
    );
  }

  if (session.result.columns.length === 0) {
    return (
      <div className="db-sql-result-session">
        <div className="empty-state compact" style={{ padding: "var(--sp-4)" }}>
          {t("database.results.affected", { rows: session.result.rowsAffected })}
        </div>
        {showStandaloneFooter ? (
          <div className="db-pagination db-sql-results-footer">
            <div className="db-pagination-extra">{footerExtra}</div>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="db-sql-result-session">
      <div className="results-area db-sql-results">
        <TableDataGrid
          columns={columns}
          rows={resultRows}
          totalRows={estimatedTotalRows}
          page={resultPage}
          pageSize={databaseQueryPageSize}
          loading={session.running}
          hideTotalRowCount
          onPageChange={handleQueryPageChange}
          footerExtra={footerExtra}
          gridActionsRef={selectionReporting ? gridActionsRef : undefined}
          onActiveCellChange={handleActiveCellChange}
          onSelectedCellsChange={handleSelectedCellsChange}
          cellEditorCollapsed={detailCollapsed}
          reserveSelectionOnEscape
          onCellEditorFocusRequest={
            selectionReporting ? onCellEditorFocusRequest : undefined
          }
          onRowBandSelect={selectionReporting ? onRowBandSelect : undefined}
        />
      </div>
      <ImportToTableDialog
        open={importDialogOpen}
        payload={importPayload}
        connections={ws.sqlConnections}
        databasesByConnId={ws.databasesByConnId}
        onClose={() => {
          setImportDialogOpen(false);
          setImportPayload(null);
        }}
      />
    </div>
  );
});
