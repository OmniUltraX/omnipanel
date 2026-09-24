import { memo, useCallback, useRef, useState } from "react";
import { useSettingsStore } from "../../../stores/settingsStore";
import { useDbWorkspace } from "../../../contexts/DbWorkspaceContext";
import { WorkbenchActionButton } from "../../../components/ui/primitives/WorkbenchActionButton";
import { showToast } from "../../../stores/toastStore";
import { writeToClipboard } from "../panel/useDatabasePanelCsvExport";
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
  const [resultView, setResultView] = useState<"grid" | "summary" | "chart" | "messages">("grid");
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

  const copySql = useCallback(async () => {
    const ok = await writeToClipboard(session.sql);
    showToast(ok ? t("database.results.copiedSql") : t("database.tablesPanel.copyFailed"));
  }, [session.sql, t]);

  const numericColumn = columns.find((column) =>
    resultRows.some((row) => typeof row[column] === "number" && Number.isFinite(row[column] as number)),
  );

  const tabBar = (
    <div className="results-header shrink-0">
      <div className="results-tabs" style={{ marginLeft: 0 }}>
      {(
        [
          ["grid", t("database.results.tabGrid")],
          ["summary", t("database.results.tabSummary")],
          ["chart", t("database.results.tabChart")],
          ["messages", t("database.results.tabMessages")],
        ] as const
      ).map(([id, label]) => (
        <button
          key={id}
          type="button"
          className={`results-tab${resultView === id ? " active" : ""}`}
          onClick={() => setResultView(id)}
        >
          {label}
        </button>
      ))}
      </div>
      <div className="ml-auto flex items-center gap-1">
        <WorkbenchActionButton onClick={() => void copySql()} disabled={!session.sql.trim()}>
          {t("database.results.copySql")}
        </WorkbenchActionButton>
        {canExport ? (
          <WorkbenchActionButton
            disabled={session.running}
            onClick={(event) => ws.openExportMenu(event.clientX, event.clientY, sqlTabId, session.id)}
          >
            {t("database.results.exportCsv")}
          </WorkbenchActionButton>
        ) : null}
        {canExport ? (
          <WorkbenchActionButton disabled={session.running} onClick={openImportToTable}>
            {t("database.results.importToTable.button")}
          </WorkbenchActionButton>
        ) : null}
      </div>
    </div>
  );

  const summaryPane = (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3 text-[12px]">
      <div className="text-[10px] text-muted-foreground">{t("database.results.summarySql")}</div>
      <pre className="whitespace-pre-wrap rounded border border-border bg-muted/30 p-2 font-mono text-[12px]">
        {session.sql || "—"}
      </pre>
      <div className="flex flex-wrap gap-4 text-muted-foreground">
        <span>
          {t("database.results.summaryElapsed")}：{session.elapsed != null ? `${session.elapsed} ms` : "—"}
        </span>
        <span>
          {t("database.results.summaryRows")}：{rowCount}
        </span>
        <span>
          {t("database.results.summaryAffected")}：{session.result?.rowsAffected ?? 0}
        </span>
      </div>
    </div>
  );

  const chartPane = !numericColumn ? (
    <div className="empty-state compact" style={{ padding: "var(--sp-4)" }}>
      {t("database.results.chartEmpty")}
    </div>
  ) : (
    <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto p-3">
      <div className="text-[11px] text-muted-foreground">{numericColumn}</div>
      {resultRows.slice(0, 12).map((row, index) => {
        const value = Number(row[numericColumn] ?? 0);
        const max = Math.max(
          ...resultRows.slice(0, 12).map((item) => Math.abs(Number(item[numericColumn] ?? 0))),
          1,
        );
        const width = `${Math.round((Math.abs(value) / max) * 100)}%`;
        return (
          <div key={index} className="flex items-center gap-2 text-[11px]">
            <span className="w-8 shrink-0 text-muted-foreground">{index + 1}</span>
            <span className="h-3 rounded bg-[#3d9a4a]" style={{ width }} />
            <span className="shrink-0">{value}</span>
          </div>
        );
      })}
    </div>
  );

  const messagePane = (
    <div
      className={`empty-state compact ${session.error ? "text-danger" : ""}`}
      style={{ padding: "var(--sp-4)", whiteSpace: "pre-wrap" }}
    >
      {session.error
        ?? (session.result && session.result.columns.length === 0
          ? t("database.results.affected", { rows: session.result.rowsAffected })
          : session.result
            ? `${t("database.results.messageOk")} · ${rowCount}`
            : t("database.results.runHint"))}
    </div>
  );

  const gridPane =
    session.running && !session.result && !session.error ? (
      <div className="empty-state compact" style={{ padding: "var(--sp-4)" }}>
        {t("database.running")}
      </div>
    ) : session.result && session.result.columns.length > 0 ? (
      <div className="results-area db-sql-results min-h-0 flex-1">
        <TableDataGrid
          columns={columns}
          rows={resultRows}
          totalRows={estimatedTotalRows}
          page={resultPage}
          pageSize={databaseQueryPageSize}
          loading={session.running}
          hideTotalRowCount
          onPageChange={handleQueryPageChange}
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
    ) : (
      <div className="empty-state compact" style={{ padding: "var(--sp-4)", whiteSpace: "pre-wrap" }}>
        {session.error
          ? session.error
          : session.result
            ? t("database.results.affected", { rows: session.result.rowsAffected })
            : t("database.results.runHint")}
      </div>
    );

  const body =
    resultView === "summary"
      ? summaryPane
      : resultView === "chart"
        ? chartPane
        : resultView === "messages"
          ? messagePane
          : gridPane;

  return (
    <div className="db-sql-result-session flex h-full min-h-0 flex-col">
      {tabBar}
      {body}
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
