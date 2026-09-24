import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
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
import { WorkbenchActionButton } from "../../../components/ui/primitives/WorkbenchActionButton";
import { Select } from "../../../components/ui/form/Select";
import { SqlEditor, type SqlEditorHandle, type SqlEditorOpenMode } from "../sql/SqlEditor";
import { SqlEditorScopedSearch } from "../sql/SqlEditorScopedSearch";
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
import { SqlToolbarLeftControls } from "../sql/SqlToolbarLeftControls";
import { registerSqlRepairApply, setSqlRepairNote } from "../sql/sqlExecErrorPresent";
import { requestAiCompletionOnce } from "../../../lib/ai/requestAiCompletionOnce";
import { SqlEditorContextMenu } from "../sql/SqlEditorContextMenu";
import {
  closeSqlEditorMenu,
  getSqlEditorMenu,
  subscribeSqlEditorMenu,
} from "../sql/sqlEditorMenuSignal";
import { registerSqlCursorInsert } from "../sql/sqlExecLog";
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
  onHasSelectionChange: (hasSelection: boolean) => void;
  execError: { sql: string; message: string } | null;
  onExplainError: () => void;
  onRun: (sql: string) => void;
  onRunSelected: (selectedSql: string) => void;
  onRunAll: () => void;
  onSave: () => void;
  onOpenTable: (target: { databaseName: string; tableName: string }) => void;
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
  onHasSelectionChange,
  execError,
  onExplainError,
  onRun,
  onRunSelected,
  onRunAll,
  onSave,
  onOpenTable,
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
      onHasSelectionChange={onHasSelectionChange}
      execError={execError}
      onExplainError={onExplainError}
      onRun={onRun}
      onRunSelected={onRunSelected}
      onRunAll={onRunAll}
      onSave={onSave}
      onOpenTable={onOpenTable}
      contextMenuKey={tabId}
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
  const [findSignal, setFindSignal] = useState(0);
  const editorMenuSignal = useSyncExternalStore(subscribeSqlEditorMenu, getSqlEditorMenu);
  const editorMenu = editorMenuSignal?.key === tab.id ? editorMenuSignal : null;

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
  const handleOpenTableFromSql = useCallback(
    (target: { databaseName: string; tableName: string }) => {
      if (!tabConn) return;
      ws.selectTable({
        connId: tabConn.id,
        dbName: target.databaseName,
        tableName: target.tableName,
        connection: tabConn,
      });
    },
    [tabConn, ws.selectTable],
  );
  const sqlEditorOpenMode = ws.tabModeToEditorOpenMode(_mode);
  const sqlEditorRef = useRef<SqlEditorHandle>(null);
  useEffect(() => {
    if (!isActiveTab) return;
    return registerSqlCursorInsert((sql) => {
      const editor = sqlEditorRef.current;
      if (!editor) return;
      const selection = editor.getSelection();
      const prefix = selection.doc.trim() ? "\n" : "";
      editor.replaceRange(selection.head, selection.head, `${prefix}${sql}`);
    });
  }, [isActiveTab]);

  const canRunSql = Boolean(
    tabConn &&
      (tabState.database.trim() ||
        !sqlRequiresDatabaseContext(tabState.sql) ||
        !sqlRequiresDatabaseContext(sqlAtOffset(tabState.sql, tabState.cursorOffset))),
  );

  const [hasSqlSelection, setHasSqlSelection] = useState(false);

  const runSelectedSql = useCallback(() => {
    const sql = sqlEditorRef.current?.getSelectedSql() ?? "";
    if (!sql.trim()) {
      ws.updateSqlTabState(tab.id, { error: t("database.results.emptySelection") });
      return;
    }
    sqlEditorRef.current?.highlightSql(sql);
    void ws.runQuery(sql, tab.id);
  }, [ws, tab.id, t]);

  const runAllSql = useCallback(() => {
    const doc = sqlEditorRef.current?.getSelection().doc ?? "";
    if (doc.trim()) sqlEditorRef.current?.highlightSql(doc);
    void ws.runQuery(undefined, tab.id);
  }, [ws.runQuery, tab.id]);

  const execError = useMemo(() => {
    if (!activeResultSession?.error) return null;
    return { sql: activeResultSession.sql, message: activeResultSession.error };
  }, [activeResultSession?.error, activeResultSession?.sql]);

  useEffect(() => {
    return registerSqlRepairApply((sql) => {
      const editor = sqlEditorRef.current;
      const target = execError?.sql ?? "";
      if (!editor || !target.trim()) return;
      const doc = editor.getSelection().doc;
      const at = doc.indexOf(target);
      if (at < 0) {
        editor.replaceRange(0, doc.length, sql);
        return;
      }
      editor.replaceRange(at, at + target.length, sql);
    });
  }, [execError?.sql]);

  const explainError = useCallback(() => {
    if (!execError) return;
    const sessionId = activeResultSession?.id ?? "";
    const publish = (content: string) => {
      const closed = content.match(/```(?:sql)?\s*([\s\S]*?)```/i);
      const open = closed ? null : content.match(/```(?:sql)?\s*([\s\S]*)$/i);
      const sql = (closed?.[1] ?? open?.[1] ?? "").trim() || null;
      const text = content
        .replace(/```(?:sql)?[\s\S]*?(?:```|$)/i, "")
        .trim();
      setSqlRepairNote({ sessionId, text: text || content, sql });
    };
    setSqlRepairNote({ sessionId, text: "正在解读这条错误…", sql: null });
    void requestAiCompletionOnce({
      system: "你是 SQL 助手。用简体中文说明错误原因。如果能改写，最后给一个 sql 代码块，只含替换后的语句。",
      user: `数据库类型：${tabConn?.db_type ?? "unknown"}\n语句：\n${execError.sql}\n错误：\n${execError.message}`,
      pureText: true,
      onDelta: publish,
    }).then((result) => {
      if (!result.ok) {
        setSqlRepairNote({ sessionId, text: "没能完成解读。", sql: null });
        return;
      }
      publish(result.content);
    });
  }, [activeResultSession?.id, execError, tabConn?.db_type]);

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
  const supportsManualTxn = useMemo(() => {
    const t = (tabConn?.db_type ?? "").toLowerCase();
    return t === "mysql" || t === "mariadb" || t === "postgres" || t === "postgresql" || t === "pg";
  }, [tabConn?.db_type]);

  const toolbarContent = (
    <>
      <div className="sql-toolbar">
        <div className="sql-toolbar-run">
          <WorkbenchActionButton
            disabled={!canRunSql || tabState.running}
            title={t("database.runSqlAll")}
            onClick={runAllSql}
          >
            {t("database.runSqlAll")}
          </WorkbenchActionButton>
          <WorkbenchActionButton
            disabled={!canRunSql || tabState.running || !hasSqlSelection}
            title={t("database.runSqlSelected")}
            onClick={runSelectedSql}
          >
            {t("database.runSqlSelected")}
          </WorkbenchActionButton>
        </div>
        <div className="sql-toolbar-divider" aria-hidden />
        <SqlToolbarLeftControls
          running={tabState.running}
          autoCommit={tabState.autoCommit !== false}
          inTransaction={Boolean(tabState.inTransaction)}
          supportsManualTxn={supportsManualTxn}
          onFormat={() => sqlEditorRef.current?.formatAll()}
          onCancel={() => void ws.cancelQuery(tab.id)}
          onAutoCommitChange={(next) => void ws.setSqlAutoCommit(tab.id, next)}
          onCommit={() => void ws.commitSqlTransaction(tab.id)}
          onRollback={() => void ws.rollbackSqlTransaction(tab.id)}
        />
        <div className="sql-toolbar-right">
        {schemaLoading && (
          <span className="sql-toolbar-meta">{t("common.loading")}</span>
        )}
        <Select
          className="db-select sql-toolbar-conn-select"
          size="sm"
          value={tabConn?.id ?? tabState.connId ?? ""}
          onChange={(v) => ws.setSqlTabConnection(tab.id, v || null)}
          disabled={!tabState.connId && sqlConnections.length === 0}
          title={t("database.workspace.connection")}
          panelMinWidth={240}
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
                  title: conn.name,
                  disabled: !isConnectionEnabled(conn),
                }))
          }
        />
        <Select
          className="db-select sql-toolbar-db-select"
          size="sm"
          value={tabState.database}
          onChange={(v) => ws.updateSqlTabState(tab.id, { database: v })}
          disabled={!tabState.connId}
          title={t("database.workspace.database")}
          panelMinWidth={240}
          searchable
          placeholder={t("database.workspace.noDatabase")}
          options={
            !tabConn || tabDatabases.length === 0
              ? [{ value: "", label: t("database.workspace.noDatabase"), disabled: true }]
              : tabDatabases.map((dbName) => ({ value: dbName, label: dbName, title: dbName }))
          }
        />
        </div>
      </div>
      {tabState.error && !tabState.running ? (
        <div className="sql-toolbar-error text-danger">{tabState.error}</div>
      ) : null}
    </>
  );

  const editorBody = (
    <div className="db-editor-area">
      <SqlEditorScopedSearch
        editorRef={sqlEditorRef}
        enabled={editorActive}
        docRevision={tabState.sql}
        findSignal={findSignal}
      >
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
          onHasSelectionChange={setHasSqlSelection}
          execError={execError}
          onExplainError={explainError}
          onRun={handleSqlRun}
          onRunSelected={runSelectedSql}
          onRunAll={runAllSql}
          onSave={handleSqlSave}
          onOpenTable={handleOpenTableFromSql}
        />
      </SqlEditorScopedSearch>
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

  const resultsContent = (
    <div
      className="results-area db-sql-results"
      style={isActiveTab ? undefined : { display: "none" }}
      aria-hidden={!isActiveTab}
    >
      <SqlResultSessionsDock
        sqlTabId={tab.id}
        sqlFileId={tab.sqlFileId}
        connectionId={tabState.connId}
        sessions={resultSessions}
        onHighlightSql={(sql) => {
          sqlEditorRef.current?.highlightSql(sql);
        }}
        onInsertSql={(sql) => {
          const editor = sqlEditorRef.current;
          if (!editor) return;
          const selection = editor.getSelection();
          const prefix = selection.doc.trim() ? "\n" : "";
          editor.replaceRange(selection.head, selection.head, `${prefix}${sql}`);
        }}
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
        onToggleDetail={handleDetailCollapsedChange}
        detail={detailPanel}
        detailPosition={effectiveDetailPosition}
        detailDefaultSize={detailDefaultSize}
        detailMinSize={detailMinSize}
        detailPanelRef={detailPanelRef}
        onDetailResize={handleDetailPanelResize}
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

  const editorContextMenu = (
    <SqlEditorContextMenu
      editorRef={sqlEditorRef}
      dbType={tabConn?.db_type}
      database={tabState.database}
      connection={tabConn}
      schemas={completionSchemas}
      result={activeResultSession?.result ?? null}
      menu={editorMenu}
      onClose={closeSqlEditorMenu}
      onRun={(sql) => void ws.runQuery(sql, tab.id)}
      onRunFresh={(sql) => void ws.runQuery(sql, tab.id, { freshResult: true })}
      onFind={() => setFindSignal((value) => value + 1)}
      onExportFile={() => {
        if (!activeResultSession) return;
        ws.openExportMenu(editorMenu?.x ?? 0, editorMenu?.y ?? 0, tab.id, activeResultSession.id);
      }}
      onViewData={(target) =>
        handleOpenTableFromSql({ databaseName: target.database, tableName: target.table })
      }
      onDesignTable={(target) => {
        if (!tabConn) return;
        ws.openTableDesigner({
          connId: tabConn.id,
          dbName: target.database,
          tableName: target.table,
          connection: tabConn,
        });
      }}
    />
  );

  if (!hasResultPanel) {
    return (
      <div className="db-workspace-pane db-workspace-pane--sql">
        {toolbarContent}
        {sqlMainSplit}
        {editorContextMenu}
      </div>
    );
  }

  return (
    <div className="db-workspace-pane db-workspace-pane--sql">
      {toolbarContent}
      {sqlMainSplit}
      {editorContextMenu}
    </div>
  );
});
