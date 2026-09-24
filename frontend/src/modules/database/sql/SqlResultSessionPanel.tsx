import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import type { PanelImperativeHandle, PanelSize } from "react-resizable-panels";
import { DockHandle, DockLayout, DockPanel } from "../../../components/dock";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  DATABASE_QUERY_PAGE_SIZE_OPTIONS,
  clampDatabaseQueryPageSize,
  useSettingsStore,
} from "../../../stores/settingsStore";
import { useDbWorkspace } from "../../../contexts/DbWorkspaceContext";
import { WorkbenchActionButton } from "../../../components/ui/primitives/WorkbenchActionButton";
import { showToast } from "../../../stores/toastStore";
import { writeToClipboard } from "../panel/useDatabasePanelCsvExport";
import { TableDataGrid, type TableDataGridActiveCell, type TableDataGridActions } from "../grid/TableDataGrid";
import { readStoredColSidebarCollapsed } from "../grid/colSidebarPersist";
import { TablePreviewTopBar } from "../tableDetail/TablePreviewTopBar";
import type { DbColumnMeta } from "../api";
import { selectionTargetKey, selectionTargetsKey } from "../grid/tableDataGridSelection";
import { parseOmniBlobValue } from "../grid/omniBlobValue";
import { useI18n } from "../../../i18n";
import { disambiguateColumns, estimateSqlResultTotalRows, rowsToRecord, type SqlResultSession } from "../workspace/dbWorkspaceState";
import type { MutableRefObject } from "react";
import { ImportToTableDialog, type ImportToTableDialogPayload } from "./ImportToTableDialog";
import { applySqlRepair, presentSqlExecError, readSqlRepairNote, setSqlRepairNote, subscribeSqlRepairNote } from "./sqlExecErrorPresent";
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
  onToggleDetail?: () => void;
  detail?: ReactNode;
  detailPosition?: "right" | "bottom";
  detailDefaultSize?: number | string;
  detailMinSize?: number | string;
  detailPanelRef?: RefObject<PanelImperativeHandle | null>;
  onDetailResize?: (size: PanelSize) => void;
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
  onToggleDetail,
  detail,
  detailPosition = "right",
  detailDefaultSize = 320,
  detailMinSize = 200,
  detailPanelRef,
  onDetailResize,
}: SqlResultSessionPanelProps) {
  const { t } = useI18n();
  const ws = useDbWorkspace();
  const databaseQueryPageSize = useSettingsStore((s) => s.databaseQueryPageSize);
  const setDatabaseSettings = useSettingsStore((s) => s.setDatabaseSettings);
  const localActionsRef = useRef<TableDataGridActions | null>(null);
  const actionsRef = gridActionsRef ?? localActionsRef;
  const [transposed, setTransposed] = useState(false);
  const [colSidebarCollapsed, setColSidebarCollapsed] = useState(readStoredColSidebarCollapsed);
  const [copySqlHint, setCopySqlHint] = useState(false);
  const [resultView, setResultView] = useState<"grid" | "summary" | "chart">("grid");
  const shownError = session.error ? presentSqlExecError(session.error) : null;
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importPayload, setImportPayload] = useState<ImportToTableDialogPayload | null>(null);

  const activeCellRef = useRef<TableDataGridActiveCell | null>(null);
  const selectedCellsKeyRef = useRef<string | undefined>(undefined);

  const columns = useMemo(
    () => disambiguateColumns(session.result?.columns ?? []),
    [session.result],
  );
  const resultRows = useMemo(
    () => (session.result ? rowsToRecord(columns, session.result.rows) : []),
    [columns, session.result],
  );
  const columnMeta = useMemo<DbColumnMeta[]>(() => {
    const sample = resultRows[0];
    return columns.map((name) => ({
      name,
      type: inferSqlResultColumnType(name, sample?.[name]),
      isPk: false,
      isFk: false,
    }));
  }, [columns, resultRows]);
  const rowCount = resultRows.length;

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
      {resultView === "grid" && session.result && session.result.columns.length > 0 ? (
        <TablePreviewTopBar
          className="db-table-topbar--inline"
          loading={session.running}
          page={resultPage}
          pageSize={databaseQueryPageSize}
          totalPages={Math.max(1, Math.ceil(estimatedTotalRows / Math.max(databaseQueryPageSize, 1)))}
          dirtyCount={0}
          isCommitting={false}
          canUndoDirty={false}
          canRedoDirty={false}
          canInsertRow={false}
          canDeleteRow={false}
          hasSelectedRows={false}
          selectedRowCount={0}
          canExport={canExport && !session.running}
          canDesignTable={false}
          canCreateTableQuery={false}
          transposed={transposed}
          detailCollapsed={detailCollapsed}
          colSidebarCollapsed={colSidebarCollapsed}
          columnCount={columns.length}
          showDataEditing={false}
          showDetailToggle={Boolean(onToggleDetail)}
          pageSizeOptions={DATABASE_QUERY_PAGE_SIZE_OPTIONS}
          onPageChange={handleQueryPageChange}
          onPageSizeChange={(size) => {
            setDatabaseSettings({ databaseQueryPageSize: clampDatabaseQueryPageSize(size) });
            handleQueryPageChange(0);
          }}
          onRefresh={() => handleQueryPageChange(resultPage)}
          onInsertRow={() => {}}
          onDeleteSelectedRows={() => {}}
          onUndoAll={() => {}}
          onUndo={() => {}}
          onRedo={() => {}}
          onCommit={() => {}}
          onExport={(x, y) => ws.openExportMenu(x, y, sqlTabId, session.id)}
          onTransposeToggle={() => setTransposed((value) => !value)}
          onToggleColSidebar={() => {
            actionsRef.current?.toggleColSidebar();
            setColSidebarCollapsed(actionsRef.current?.isColSidebarCollapsed() ?? true);
          }}
          onToggleDetail={() => onToggleDetail?.()}
          onCopyPreviewSql={() => {
            void copySql().then(() => {
              setCopySqlHint(true);
              window.setTimeout(() => setCopySqlHint(false), 1200);
            });
          }}
          copySqlHint={copySqlHint}
          previewSqlTitle={session.sql}
        />
      ) : (
        <div className="min-w-0 flex-1" />
      )}
      <div className="ml-auto flex items-center gap-1">
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

  const repairNote = useSyncExternalStore(subscribeSqlRepairNote, readSqlRepairNote, readSqlRepairNote);
  const visibleRepair = repairNote?.sessionId === session.id ? repairNote : null;
  useEffect(() => {
    if (session.running) setSqlRepairNote(null);
  }, [session.running, session.id]);
  const repairBlock = visibleRepair ? (
    <div className="flex flex-col gap-2 px-4 pb-3 text-[12px]">
      <div className="sql-repair-md">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{visibleRepair.text}</ReactMarkdown>
      </div>
      {visibleRepair.sql ? (
        <WorkbenchActionButton onClick={() => applySqlRepair(visibleRepair.sql ?? "")}>
          应用修改
        </WorkbenchActionButton>
      ) : null}
    </div>
  ) : null;

  const gridPane =
    session.running && !session.result && !session.error ? (
      <div className="empty-state compact" style={{ padding: "var(--sp-4)" }}>
        {t("database.running")}
      </div>
    ) : session.result && session.result.columns.length > 0 ? (
      <div className="results-area db-sql-results flex min-h-0 flex-1 flex-col">
        <TableDataGrid
          columns={columns}
          rows={resultRows}
          columnMeta={columnMeta}
          totalRows={estimatedTotalRows}
          page={resultPage}
          pageSize={databaseQueryPageSize}
          loading={session.running}
          hideTotalRowCount
          chromePlacement="none"
          enableTranspose
          transposed={transposed}
          onTransposedChange={setTransposed}
          onPageChange={handleQueryPageChange}
          gridActionsRef={actionsRef}
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
      <div className="min-h-0 flex-1 overflow-auto">
        <div className={`empty-state compact ${shownError ? "text-danger" : ""}`} style={{ padding: "var(--sp-4)", whiteSpace: "pre-wrap" }}>
          {shownError
            ? shownError
            : session.result
              ? t("database.results.affected", { rows: session.result.rowsAffected })
              : t("database.results.runHint")}
        </div>
        {repairBlock}
      </div>
    );

  const body =
    resultView === "summary"
      ? summaryPane
      : resultView === "chart"
        ? chartPane
        : gridPane;

  const detailSplit = detail ? (
    <DockLayout
      direction={detailPosition === "right" ? "horizontal" : "vertical"}
      className="min-h-0 flex-1"
    >
      <DockPanel minSize="160px">{body}</DockPanel>
      <DockHandle direction={detailPosition === "right" ? "horizontal" : "vertical"} />
      <DockPanel
        defaultSize={detailCollapsed ? 0 : detailDefaultSize}
        minSize={detailMinSize}
        collapsible
        collapsedSize={0}
        groupResizeBehavior="preserve-pixel-size"
        panelRef={detailPanelRef}
        onResize={onDetailResize}
        className={detailPosition === "right" ? "dock-panel-right" : "dock-panel-bottom"}
      >
        {detail}
      </DockPanel>
    </DockLayout>
  ) : (
    body
  );

  return (
    <div className="db-sql-result-session flex h-full min-h-0 flex-col">
      {tabBar}
      {detailSplit}
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
