import { memo, useCallback, useMemo, useRef } from "react";
import { useSettingsStore } from "../../../stores/settingsStore";
import { useDbWorkspace } from "../../../contexts/DbWorkspaceContext";
import { Button } from "../../../components/ui/primitives/Button";
import { TableDataGrid, type TableDataGridActiveCell, type TableDataGridActions } from "../grid/TableDataGrid";
import { selectionTargetKey, selectionTargetsKey } from "../grid/tableDataGridSelection";
import { parseOmniBlobValue } from "../grid/omniBlobValue";
import { useI18n } from "../../../i18n";
import { estimateSqlResultTotalRows, type SqlResultSession } from "../workspace/dbWorkspaceState";
import type { MutableRefObject } from "react";

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
  resultHasMore,
  estimatedTotalRows,
}: {
  session: SqlResultSession;
  sqlTabId: string;
  canExport: boolean;
  resultHasMore: boolean;
  estimatedTotalRows: number;
}) {
  const { t } = useI18n();
  const ws = useDbWorkspace();

  if (session.running) return null;

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
      {session.result || session.error ? (
        <span className="results-meta">
          {t("database.results.meta", {
            rows: resultHasMore ? `${estimatedTotalRows}+` : estimatedTotalRows,
            ms: session.elapsed ?? 0,
            mode: t("common.readonly"),
          })}
          {resultHasMore ? (
            <span className="db-exec-stats-truncated">
              {" · "}
              {t("database.results.hasMore")}
            </span>
          ) : null}
        </span>
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
    (page: number) => void ws.goToQueryResultPage(sqlTabId, page, session.id),
    [ws.goToQueryResultPage, sqlTabId, session.id],
  );

  const sqlPreview = useMemo(() => {
    const compact = session.sql.replace(/\s+/g, " ").trim();
    return compact.length > 120 ? `${compact.slice(0, 120)}…` : compact;
  }, [session.sql]);

  const footerExtra = useMemo(
    () => (
      <SqlResultSessionFooterExtra
        session={session}
        sqlTabId={sqlTabId}
        canExport={canExport}
        resultHasMore={resultHasMore}
        estimatedTotalRows={estimatedTotalRows}
      />
    ),
    [session, sqlTabId, canExport, resultHasMore, estimatedTotalRows],
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

  if (session.running) {
    return (
      <div className="db-sql-result-session">
        {sqlPreview ? (
          <div className="db-sql-result-query" title={session.sql}>
            {sqlPreview}
          </div>
        ) : null}
        <div className="empty-state compact" style={{ padding: "var(--sp-4)" }}>
          {t("database.running")}
        </div>
      </div>
    );
  }

  if (session.error) {
    return (
      <div className="db-sql-result-session">
        {sqlPreview ? (
          <div className="db-sql-result-query" title={session.sql}>
            {sqlPreview}
          </div>
        ) : null}
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
        {sqlPreview ? (
          <div className="db-sql-result-query" title={session.sql}>
            {sqlPreview}
          </div>
        ) : null}
        <div className="empty-state compact" style={{ padding: "var(--sp-4)" }}>
          {t("database.results.runHint")}
        </div>
      </div>
    );
  }

  if (session.result.columns.length === 0) {
    return (
      <div className="db-sql-result-session">
        {sqlPreview ? (
          <div className="db-sql-result-query" title={session.sql}>
            {sqlPreview}
          </div>
        ) : null}
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
      {sqlPreview ? (
        <div className="db-sql-result-query" title={session.sql}>
          {sqlPreview}
        </div>
      ) : null}
      <div className="results-area db-sql-results">
        <TableDataGrid
          columns={columns}
          rows={resultRows}
          totalRows={estimatedTotalRows}
          page={resultPage}
          pageSize={databaseQueryPageSize}
          loading={session.running}
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
    </div>
  );
});
