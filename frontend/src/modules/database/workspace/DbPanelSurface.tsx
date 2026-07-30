import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PanelImperativeHandle, PanelSize } from "react-resizable-panels";
import { useModuleSuspended } from "../../../lib/moduleVisibility";
import {
  useDbWorkspace,
  useDbTabWorkspaceSliceOrMirror,
} from "../../../contexts/DbWorkspaceContext";
import { useDbDockTabActive } from "../useDbDockTabActive";
import type { SqlWorkspaceTab } from "./workspaceTabs";
import { DockLayout, DockHandle, DockPanel } from "../../../components/dock";
import { ToolbarMenuButton } from "../../../components/ui/menu/ToolbarMenuButton";
import { Button } from "../../../components/ui/primitives/Button";
import { Select } from "../../../components/ui/form/Select";
import { SqlEditor, type SqlEditorHandle, type SqlEditorOpenMode } from "../sql/SqlEditor";
import { SqlResultSessionsDock } from "../sql/SqlResultSessionsDock";
import { inferSqlResultColumnType } from "../sql/SqlResultSessionPanel";
import { type CellEditorPanelHandle } from "../cell_editor";
import {
  TableDetailPanel,
  type TableDetailTab,
} from "../tableDetail/TableDetailPanel";
import type { TableDataGridActiveCell, TableDataGridActions } from "../grid/TableDataGrid";
import { useI18n } from "../../../i18n";
import { createDefaultSqlTabState, type SqlTabState } from "./dbWorkspaceState";
import { sqlAtOffset } from "../sqlIntel/sqlStatement";
import { sqlRequiresDatabaseContext } from "../sqlIntel/connectionLevelSql";
import { isConnectionEnabled } from "../api";
import type { DatabaseSchema } from "../types";
import {
  useSettingsStore,
  type DatabaseTableDetailPosition,
} from "../../../stores/settingsStore";

interface DbPanelSurfaceProps {
  tab: SqlWorkspaceTab;
  /** 镜像窗传入；主面板省略，走 useDbDockTabActive */
  active?: boolean;
}

interface DbPanelSqlEditorProps {
  tabId: string;
  tabState: SqlTabState;
  openMode: SqlEditorOpenMode;
  dbType?: string;
  scopedSchemas: DatabaseSchema[];
  editorRef: React.RefObject<SqlEditorHandle | null>;
  editorActive: boolean;
  onChange: (value: string) => void;
  onCursorOffsetChange: (cursorOffset: number) => void;
  onRun: (sql: string) => void;
  onRunSelected: (selectedSql: string) => void;
  onRunAll: () => void;
  onSave: () => void;
}

const DETAIL_DEFAULT_SIZE_PX: Record<DatabaseTableDetailPosition, number> = {
  right: 360,
  bottom: 280,
};
const DETAIL_MIN_SIZE_PX: Record<DatabaseTableDetailPosition, number> = {
  right: 240,
  bottom: 180,
};

function toPanelPx(px: number): string {
  return `${Math.max(0, Math.round(px))}px`;
}

/** 激活态由父级传入，避免本组件再订 ActiveTab Context。 */
const DbPanelSqlEditor = memo(function DbPanelSqlEditor({
  tabId,
  tabState,
  openMode,
  dbType,
  scopedSchemas,
  editorRef,
  editorActive,
  onChange,
  onCursorOffsetChange,
  onRun,
  onRunSelected,
  onRunAll,
  onSave,
}: DbPanelSqlEditorProps) {
  return (
    <SqlEditor
      ref={editorRef}
      key={tabId}
      editorActive={editorActive}
      openMode={openMode}
      dbType={dbType}
      value={tabState.sql}
      onChange={onChange}
      onCursorOffsetChange={onCursorOffsetChange}
      onRun={onRun}
      onRunSelected={onRunSelected}
      onRunAll={onRunAll}
      onSave={onSave}
      schemas={scopedSchemas}
    />
  );
});

export const DbPanelSurface = memo(function DbPanelSurface({
  tab,
  active: activeProp,
}: DbPanelSurfaceProps) {
  const { t } = useI18n();
  const ws = useDbWorkspace();
  const storeActive = useDbDockTabActive(tab.id);
  const isActiveTab = activeProp ?? storeActive;
  const moduleSuspended = useModuleSuspended();
  const editorActive = isActiveTab && !moduleSuspended;
  const {
    sqlTabState,
    tabMode: _mode,
  } = useDbTabWorkspaceSliceOrMirror(tab.id);
  const tabState = sqlTabState ?? createDefaultSqlTabState();

  const detailPosition = useSettingsStore((s) => s.databaseTableDetailPosition);
  const setDatabaseSettings = useSettingsStore((s) => s.setDatabaseSettings);

  const resultSessions = tabState.resultSessions ?? [];
  const hasResultPanel = resultSessions.length > 0;

  const activeResultSession = useMemo(() => {
    const activeId = tabState.activeResultSessionId;
    if (activeId) {
      const found = resultSessions.find((s) => s.id === activeId);
      if (found) return found;
    }
    return resultSessions[resultSessions.length - 1] ?? null;
  }, [resultSessions, tabState.activeResultSessionId]);

  const tabConn = ws.resolveSqlTabConnection(tab.id);
  const tabDatabases = ws.getSqlTabDatabases(tab.id);
  const completionSchemas = ws.getSqlCompletionSchemas(tab.id);

  const schemaKey =
    tabConn && tabState.database.trim()
      ? `${tabConn.id}:${tabState.database}`
      : null;
  const schemaLoading = schemaKey !== null && ws.schemaLoadingKey === schemaKey;

  const sqlConnections = ws.sqlConnections;

  const cellEditorRef = useRef<CellEditorPanelHandle>(null);
  const gridActionsRef = useRef<TableDataGridActions | null>(null);
  const detailPanelRef = useRef<PanelImperativeHandle | null>(null);
  const detailSizePxByPositionRef = useRef<Record<DatabaseTableDetailPosition, number>>({
    ...DETAIL_DEFAULT_SIZE_PX,
  });
  const detailCollapseSyncingRef = useRef(false);

  const [detailCollapsed, setDetailCollapsed] = useState(true);
  const [detailTab, setDetailTab] = useState<TableDetailTab>("value");
  const [activeCell, setActiveCell] = useState<TableDataGridActiveCell | null>(null);
  const [selectedCells, setSelectedCells] = useState<TableDataGridActiveCell[]>([]);

  const handleSqlChange = useCallback(
    (value: string) => {
      ws.updateSqlTabState(tab.id, {
        sql: value,
        ...(tabState.error ? { error: null } : {}),
      });
    },
    [ws.updateSqlTabState, tab.id, tabState.error],
  );
  const handleSqlCursorChange = useCallback(
    (cursorOffset: number) => ws.updateSqlTabState(tab.id, { cursorOffset }),
    [ws.updateSqlTabState, tab.id],
  );
  const handleSqlRun = useCallback(
    (sql: string) => void ws.runQuery(sql, tab.id),
    [ws.runQuery, tab.id],
  );
  const handleSqlSave = useCallback(
    () => void ws.saveSqlTab(tab.id),
    [ws.saveSqlTab, tab.id],
  );
  const sqlEditorOpenMode = ws.tabModeToEditorOpenMode(_mode);
  const sqlEditorRef = useRef<SqlEditorHandle>(null);

  const canRunSql = Boolean(
    tabConn &&
      (tabState.database.trim() ||
        !sqlRequiresDatabaseContext(tabState.sql) ||
        !sqlRequiresDatabaseContext(sqlAtOffset(tabState.sql, tabState.cursorOffset))),
  );

  const runCurrentSql = useCallback(() => {
    const sql =
      sqlEditorRef.current?.getSqlAtCursor() ??
      sqlAtOffset(tabState.sql, tabState.cursorOffset);
    if (!sql.trim()) {
      ws.updateSqlTabState(tab.id, { error: t("database.results.emptySql") });
      return;
    }
    void ws.runQuery(sql, tab.id);
  }, [ws, tab.id, tabState.sql, tabState.cursorOffset, t]);

  const runSelectedSql = useCallback(() => {
    const sql = sqlEditorRef.current?.getSelectedSql() ?? "";
    if (!sql.trim()) {
      ws.updateSqlTabState(tab.id, { error: t("database.results.emptySelection") });
      return;
    }
    void ws.runQuery(sql, tab.id);
  }, [ws, tab.id, t]);

  const runAllSql = useCallback(() => {
    void ws.runQuery(undefined, tab.id);
  }, [ws.runQuery, tab.id]);

  const runSqlMenuItems = useMemo(
    () => [
      {
        id: "run-current",
        label: t("database.runSqlCurrent"),
        onSelect: runCurrentSql,
      },
      {
        id: "run-selected",
        label: t("database.runSqlSelected"),
        onSelect: runSelectedSql,
      },
      {
        id: "run-all",
        label: t("database.runSqlAll"),
        onSelect: runAllSql,
      },
    ],
    [t, runCurrentSql, runSelectedSql, runAllSql],
  );

  const handleActiveSessionChange = useCallback(
    (sessionId: string) => {
      setActiveCell(null);
      setSelectedCells([]);
      ws.updateSqlTabState(tab.id, { activeResultSessionId: sessionId });
    },
    [ws.updateSqlTabState, tab.id],
  );

  const handleCloseSession = useCallback(
    (sessionId: string) => {
      ws.closeSqlResultSession(tab.id, sessionId);
    },
    [ws.closeSqlResultSession, tab.id],
  );

  const handlePinSession = useCallback(
    (sessionId: string, pinned: boolean) => {
      ws.setSqlResultSessionPinned(tab.id, sessionId, pinned);
    },
    [ws.setSqlResultSessionPinned, tab.id],
  );

  const handleActiveCellChange = useCallback((cell: TableDataGridActiveCell | null) => {
    setActiveCell(cell);
  }, []);

  const handleSelectedCellsChange = useCallback((cells: TableDataGridActiveCell[]) => {
    setSelectedCells(cells);
  }, []);

  const effectiveDetailPosition = detailPosition;
  const splitDirection = effectiveDetailPosition === "right" ? "horizontal" : "vertical";
  const detailDefaultSize = toPanelPx(DETAIL_DEFAULT_SIZE_PX[effectiveDetailPosition]);
  const detailMinSize = toPanelPx(DETAIL_MIN_SIZE_PX[effectiveDetailPosition]);

  const editorColumnName = activeCell?.column ?? selectedCells[0]?.column ?? null;
  const editorSelectionCount = selectedCells.length;
  const activeRow = activeCell?.row ?? selectedCells[0]?.row ?? null;
  const activeCellValue = useMemo(() => {
    if (!activeCell) return undefined;
    return activeCell.row[activeCell.column];
  }, [activeCell]);

  const activeCellKey = useMemo(() => {
    if (activeCell) {
      return `${activeCell.rowIndex}:${activeCell.column}`;
    }
    if (selectedCells.length > 1) {
      return `multi:${selectedCells.length}`;
    }
    return null;
  }, [activeCell, selectedCells.length]);

  const inferredColumnType = useMemo(() => {
    if (editorSelectionCount > 1) return "text";
    if (!editorColumnName) return "text";
    return inferSqlResultColumnType(editorColumnName, activeCellValue);
  }, [activeCellValue, editorColumnName, editorSelectionCount]);

  const detailColumns = activeResultSession?.result?.columns ?? [];

  const expandDetailPanel = useCallback(() => {
    const handle = detailPanelRef.current;
    if (!handle) {
      setDetailCollapsed(false);
      return;
    }
    if (handle.isCollapsed()) {
      detailCollapseSyncingRef.current = true;
      try {
        handle.expand();
        handle.resize(toPanelPx(detailSizePxByPositionRef.current[effectiveDetailPosition]));
      } finally {
        queueMicrotask(() => {
          detailCollapseSyncingRef.current = false;
        });
      }
    }
    setDetailCollapsed(false);
  }, [effectiveDetailPosition]);

  const collapseDetailPanel = useCallback(() => {
    cellEditorRef.current?.commitIfDirty();
    const handle = detailPanelRef.current;
    if (handle && !handle.isCollapsed()) {
      detailCollapseSyncingRef.current = true;
      try {
        handle.collapse();
      } finally {
        queueMicrotask(() => {
          detailCollapseSyncingRef.current = false;
        });
      }
    }
    setDetailCollapsed(true);
  }, []);

  const clearResultSelection = useCallback(() => {
    gridActionsRef.current?.clearSelection();
    setActiveCell(null);
    setSelectedCells([]);
  }, []);

  const handleCellEditorFocusRequest = useCallback(() => {
    setDetailTab("value");
    if (detailCollapsed) {
      expandDetailPanel();
    }
    cellEditorRef.current?.focusEditor();
  }, [detailCollapsed, expandDetailPanel]);

  const handleRowBandSelect = useCallback(() => {
    if (!detailCollapsed) {
      setDetailTab("record");
    }
  }, [detailCollapsed]);

  const handleDetailCollapsedChange = useCallback(() => {
    const handle = detailPanelRef.current;
    if (!handle) {
      setDetailCollapsed((v) => !v);
      return;
    }
    detailCollapseSyncingRef.current = true;
    try {
      if (handle.isCollapsed()) {
        handle.expand();
        handle.resize(toPanelPx(detailSizePxByPositionRef.current[effectiveDetailPosition]));
        setDetailCollapsed(false);
      } else {
        handle.collapse();
        setDetailCollapsed(true);
      }
    } finally {
      queueMicrotask(() => {
        detailCollapseSyncingRef.current = false;
      });
    }
  }, [effectiveDetailPosition]);

  const handleDetailPanelResize = useCallback(
    (panelSize: PanelSize) => {
      if (detailCollapseSyncingRef.current) return;
      const collapsed = detailPanelRef.current?.isCollapsed() ?? false;
      setDetailCollapsed(collapsed);
      const minPx = DETAIL_MIN_SIZE_PX[effectiveDetailPosition];
      if (!collapsed && panelSize.inPixels >= minPx) {
        detailSizePxByPositionRef.current[effectiveDetailPosition] = panelSize.inPixels;
      }
    },
    [effectiveDetailPosition],
  );

  const handlePositionChange = useCallback(
    (position: DatabaseTableDetailPosition) => {
      setDatabaseSettings({ databaseTableDetailPosition: position });
    },
    [setDatabaseSettings],
  );

  useLayoutEffect(() => {
    if (!hasResultPanel) return;
    const handle = detailPanelRef.current;
    if (!handle) return;
    detailCollapseSyncingRef.current = true;
    try {
      if (detailCollapsed) {
        handle.collapse();
      } else {
        handle.expand();
        handle.resize(toPanelPx(detailSizePxByPositionRef.current[effectiveDetailPosition]));
      }
    } finally {
      queueMicrotask(() => {
        detailCollapseSyncingRef.current = false;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅形态变化时同步
  }, [effectiveDetailPosition, hasResultPanel]);

  // 激活单元格时自动打开「值」预览
  useLayoutEffect(() => {
    if (!activeCell) return;
    setDetailTab("value");
    if (detailCollapsed) {
      expandDetailPanel();
    }
  }, [activeCellKey]); // eslint-disable-line react-hooks/exhaustive-deps -- 仅单元格切换时展开

  // 失去单元格焦点 / 选区清空 → 收起预览
  useEffect(() => {
    if (detailCollapsed) return;
    if (activeCell != null || selectedCells.length > 0) return;
    collapseDetailPanel();
  }, [activeCell, selectedCells.length, detailCollapsed, collapseDetailPanel]);

  // Esc：先收起预览，再清除单元格焦点
  useEffect(() => {
    if (!isActiveTab || !hasResultPanel) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (event.defaultPrevented) return;
      if (document.querySelector(".db-cell-preview-subwindow.subwindow-panel")) {
        return;
      }

      const grid = gridActionsRef.current;
      if (grid?.hasInlineEdit()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        grid.cancelInlineEdit();
        return;
      }

      if (!detailCollapsed) {
        event.preventDefault();
        event.stopImmediatePropagation();
        collapseDetailPanel();
        clearResultSelection();
        return;
      }

      if (grid?.hasSelection() || activeCell != null || selectedCells.length > 0) {
        event.preventDefault();
        event.stopImmediatePropagation();
        clearResultSelection();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [
    isActiveTab,
    hasResultPanel,
    detailCollapsed,
    activeCell,
    selectedCells.length,
    collapseDetailPanel,
    clearResultSelection,
  ]);
  /** 工具栏通栏在上；预览分栏只占工具栏以下区域 */
  const toolbarContent = (
    <>
      <div className="sql-toolbar">
        <Select
          className="db-select"
          value={tabConn?.id ?? tabState.connId ?? ""}
          onChange={(v) => ws.setSqlTabConnection(tab.id, v || null)}
          disabled={!tabState.connId && sqlConnections.length === 0}
          title={t("database.workspace.connection")}
          searchable
          placeholder={t("database.results.noConnection")}
          options={
            sqlConnections.length === 0
              ? [{ value: "", label: t("database.results.noConnection"), disabled: true }]
              : sqlConnections.map((conn) => ({
                  value: conn.id,
                  label: isConnectionEnabled(conn)
                    ? conn.name
                    : `${conn.name} (${t("database.sidebar.connectionDisabled")})`,
                  disabled: !isConnectionEnabled(conn),
                }))
          }
        />
        <Select
          className="db-select"
          value={tabState.database}
          onChange={(v) => ws.updateSqlTabState(tab.id, { database: v })}
          disabled={!tabState.connId}
          title={t("database.workspace.database")}
          searchable
          placeholder={t("database.workspace.noDatabase")}
          options={
            !tabConn || tabDatabases.length === 0
              ? [{ value: "", label: t("database.workspace.noDatabase"), disabled: true }]
              : tabDatabases.map((dbName) => ({ value: dbName, label: dbName }))
          }
        />
        {schemaLoading && (
          <span className="sql-toolbar-meta">{t("common.loading")}</span>
        )}
        <Button
          variant="icon"
          title={t("database.formatSqlFile")}
          aria-label={t("database.formatSqlFile")}
          disabled={tabState.running}
          onClick={() => sqlEditorRef.current?.formatAll()}
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
            <path d="M2 3.5h12" strokeLinecap="round" />
            <path d="M2 7h8" strokeLinecap="round" />
            <path d="M2 10.5h10" strokeLinecap="round" />
            <path d="M2 14h6" strokeLinecap="round" />
          </svg>
        </Button>
        {tabState.running ? (
          <Button
            variant="destructive"
            size="sm"
            style={{ marginLeft: "auto" }}
            onClick={() => void ws.cancelQuery(tab.id)}
          >
            {t("database.cancelSql")}
          </Button>
        ) : (
          <ToolbarMenuButton
            label={t("database.runSql")}
            title={t("database.runSql")}
            variant="primary"
            disabled={!canRunSql}
            className="sql-toolbar-run"
            items={runSqlMenuItems}
          />
        )}
      </div>
      {tabState.error && !tabState.running ? (
        <div className="sql-toolbar-error text-danger">{tabState.error}</div>
      ) : null}
    </>
  );

  const editorBody = (
    <div className="db-editor-area">
      <DbPanelSqlEditor
        tabId={tab.id}
        tabState={tabState}
        openMode={sqlEditorOpenMode}
        dbType={tabConn?.db_type}
        scopedSchemas={completionSchemas}
        editorRef={sqlEditorRef}
        editorActive={editorActive}
        onChange={handleSqlChange}
        onCursorOffsetChange={handleSqlCursorChange}
        onRun={handleSqlRun}
        onRunSelected={runSelectedSql}
        onRunAll={runAllSql}
        onSave={handleSqlSave}
      />
    </div>
  );

  /**
   * 结果区仅属于本 SQL tab。
   * 外层 dockview 对非激活 panel 用 visibility:hidden，但嵌套结果 dock 的
   * overlay 会写 visibility:visible 并穿透到当前 Tab（表数据底下冒出 Result1）。
   * 非激活时仍用 display:none 切断穿透。
   * 切回本 tab 不闪黑：依赖 onActiveTabPreview 在 pointerdown 同步把 active 写进 store，
   * 赶在 dockview 露出面板之前先去掉 display:none。
   */
  const resultsContent = (
    <div
      className="results-area db-sql-results"
      style={isActiveTab ? undefined : { display: "none" }}
      aria-hidden={!isActiveTab}
    >
      <SqlResultSessionsDock
        sqlTabId={tab.id}
        sessions={resultSessions}
        activeSessionId={tabState.activeResultSessionId}
        onActiveSessionChange={handleActiveSessionChange}
        onCloseSession={handleCloseSession}
        onPinSession={handlePinSession}
        detailCollapsed={detailCollapsed}
        gridActionsRef={gridActionsRef}
        onActiveCellChange={handleActiveCellChange}
        onSelectedCellsChange={handleSelectedCellsChange}
        onCellEditorFocusRequest={handleCellEditorFocusRequest}
        onRowBandSelect={handleRowBandSelect}
      />
    </div>
  );

  const sqlMainSplit = hasResultPanel ? (
    <DockLayout direction="vertical" className="db-sql-split">
      <DockPanel key={tab.id} defaultSize={55} minSize={160}>
        {editorBody}
      </DockPanel>
      <DockHandle direction="vertical" />
      <DockPanel defaultSize={45} minSize={120} className="dock-panel-bottom">
        {resultsContent}
      </DockPanel>
    </DockLayout>
  ) : (
    <div className="db-sql-editor-only">{editorBody}</div>
  );

  if (!hasResultPanel) {
    return (
      <div className="db-workspace-pane db-workspace-pane--sql">
        {toolbarContent}
        {sqlMainSplit}
      </div>
    );
  }

  const detailPanel = (
    <TableDetailPanel
      activeTab={detailTab}
      onActiveTabChange={setDetailTab}
      position={effectiveDetailPosition}
      onPositionChange={handlePositionChange}
      collapsed={detailCollapsed}
      onToggleCollapsed={handleDetailCollapsedChange}
      columns={detailColumns}
      activeRow={activeRow}
      onRecordFieldApply={() => undefined}
      cellEditorRef={cellEditorRef}
      cellKey={activeCellKey}
      columnName={editorColumnName}
      columnType={inferredColumnType}
      currentValue={editorSelectionCount > 1 ? "" : activeCellValue}
      selectionCount={editorSelectionCount}
      editorOpen={!detailCollapsed}
      rowIndex={activeCell?.rowIndex ?? null}
      valueColumnMeta={
        editorColumnName
          ? {
              name: editorColumnName,
              type: inferredColumnType,
              isPk: false,
              isFk: false,
              nullable: true,
            }
          : null
      }
      onValueApply={() => undefined}
      readOnly
      showDdlTab={false}
    />
  );

  return (
    <div className="db-workspace-pane db-workspace-pane--sql">
      {toolbarContent}
      <DockLayout
        direction={splitDirection}
        className={`db-table-preview-split db-table-preview-split--${effectiveDetailPosition} db-sql-preview-split`}
      >
        <DockPanel minSize="200px">{sqlMainSplit}</DockPanel>
        <DockHandle direction={splitDirection} />
        <DockPanel
          defaultSize={detailCollapsed ? 0 : detailDefaultSize}
          minSize={detailMinSize}
          collapsible
          collapsedSize={0}
          groupResizeBehavior="preserve-pixel-size"
          panelRef={detailPanelRef}
          onResize={handleDetailPanelResize}
          className={
            effectiveDetailPosition === "right" ? "dock-panel-right" : "dock-panel-bottom"
          }
        >
          {detailPanel}
        </DockPanel>
      </DockLayout>
    </div>
  );
});
