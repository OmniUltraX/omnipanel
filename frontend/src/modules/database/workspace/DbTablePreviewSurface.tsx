import {
  useMemo,
  memo,
  useCallback,
  useRef,
  useState,
  useEffect,
  useLayoutEffect,
  useDeferredValue,
} from "react";
import type { PanelImperativeHandle, PanelSize } from "react-resizable-panels";
import {
  useDbWorkspace,
  useDbTabWorkspaceSliceOrMirror,
} from "../../../contexts/DbWorkspaceContext";
import type { TablePreviewWorkspaceTab } from "./workspaceTabs";
import { DockHandle, DockLayout, DockPanel } from "../../../components/dock";
import {
  TableDataGrid,
  type TableDataGridActions,
  type TableDataGridActiveCell,
} from "../grid/TableDataGrid";
import { selectionTargetKey, selectionTargetsKey } from "../grid/tableDataGridSelection";
import { type CellEditorPanelHandle } from "../cell_editor";
import { detectCellEditorKind, parseCellValue } from "../cell_editor/types";
import { useI18n } from "../../../i18n";
import {
  PENDING_INSERT_ROW_KEY,
  DELETED_ROW_KEY_PREFIX,
  isDeletedRowDirtyKey,
  isNewRowDirtyKey,
  matchesPreviewChangeRowFilter,
  resolvePreviewRowChangeKind,
  resolvePreviewRowKey,
  type PreviewChangeRowFilter,
  type SortState,
  type TableColumnRelationConfig,
} from "./dbWorkspaceState";
import type { RuleGroupType } from "react-querybuilder";
import { connectionHasTableSchemaChildren, fetchTableDdl } from "../api";
import { supportsTableDesign } from "../tableDesigner/resolveTableDesignerDriver";
import { useTreeChartDatabaseSchema } from "../treeChart/useTreeChartDatabaseSchema";
import {
  useSettingsStore,
  type DatabaseTableDetailPosition,
} from "../../../stores/settingsStore";
import {
  TableDetailPanel,
  type TableDetailDdlState,
  type TableDetailTab,
} from "../tableDetail/TableDetailPanel";
import { TablePreviewTopBar } from "../tableDetail/TablePreviewTopBar";
import { TablePreviewQueryBar } from "../tableDetail/TablePreviewQueryBar";
import { formatSqlDdl } from "../sql/formatSqlDdl";
import { readTableDdlCache, writeTableDdlCache } from "./tableDdlCache";
import {
  buildTablePreviewSql,
  buildTablePreviewSqlWithRelations,
} from "../grid/tablePreviewFilter";
import {
  isRelationDisplayColumn,
  relationSourceColumn,
} from "../grid/tableColumnRelation";
import { showToast } from "../../../stores/toastStore";
import { useDbWorkspaceTabStore } from "../../../stores/dbWorkspaceTabStore";
import {
  formatShortcutList,
  getShortcutKeys,
  matchesShortcut,
} from "../../../stores/shortcutsStore";

interface DbTablePreviewSurfaceProps {
  tab: TablePreviewWorkspaceTab;
  /**
   * 是否为当前激活 Tab（快捷键 / 侧栏联动等）。
   * 网格与详情面板在 keep-alive 下保持挂载，切 Tab 才能瞬间切换。
   */
  active?: boolean;
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.isContentEditable ||
    Boolean(target.closest("input, textarea, select, [contenteditable='true']"))
  );
}

function selectionTargetCount(key: string | undefined): number {
  if (!key) return 0;
  return key.split("|").filter(Boolean).length;
}

/** 详情面板默认尺寸（固定 px）。RRP v4：裸 number / "Npx" = 像素，"N%" = 百分比 */
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

export const DbTablePreviewSurface = memo(function DbTablePreviewSurface({
  tab,
  active = true,
}: DbTablePreviewSurfaceProps) {
  const { t } = useI18n();
  const ws = useDbWorkspace();
  const cellEditorRef = useRef<CellEditorPanelHandle>(null);
  const detailPanelRef = useRef<PanelImperativeHandle | null>(null);
  /** 用户拖拽后的尺寸（按右/底分别记 px），避免 expand() 回落到 minSize */
  const detailSizePxByPositionRef = useRef<Record<DatabaseTableDetailPosition, number>>({
    ...DETAIL_DEFAULT_SIZE_PX,
  });
  /** 程序化 collapse/expand 期间忽略 onResize 反写，避免挂载竞态把默认收起冲掉 */
  const detailCollapseSyncingRef = useRef(false);
  const gridActionsRef = useRef<TableDataGridActions | null>(null);
  const [detailCollapsed, setDetailCollapsed] = useState(true);
  const [colSidebarCollapsed, setColSidebarCollapsed] = useState(false);
  const [selectedRowCount, setSelectedRowCount] = useState(0);
  const [detailTab, setDetailTab] = useState<TableDetailTab>("record");
  const [activeCell, setActiveCell] = useState<TableDataGridActiveCell | null>(null);
  const [selectedCells, setSelectedCells] = useState<TableDataGridActiveCell[]>([]);
  const [copySqlHint, setCopySqlHint] = useState(false);
  const [changeRowFilter, setChangeRowFilter] = useState<PreviewChangeRowFilter>("all");
  const [ddlEntry, setDdlEntry] = useState<TableDetailDdlState>({ status: "idle" });
  const copySqlHintTimerRef = useRef<number | null>(null);
  /**
   * 延迟 TableDataGrid 首次挂载一帧。
   * 新 tab 创建时 Dockview panel 同步渲染，若此时 showPreviewGrid 已 true（warm columnMeta），
   * TableDataGrid（3500+ 行组件 + TanStack Table 实例 + Canvas 初始化）首挂会阻塞 panel 创建。
   * 延迟一帧让 panel 先创建完（骨架），下一帧再挂 grid。
   * 已有 tab 不受影响：DbTablePreviewSurface 不会重新挂载，gridMounted 保持 true。
   */
  const [gridMounted, setGridMounted] = useState(false);
  useEffect(() => {
    if (gridMounted) return;
    const raf = requestAnimationFrame(() => setGridMounted(true));
    return () => cancelAnimationFrame(raf);
  }, [gridMounted]);

  const detailPosition = useSettingsStore((s) => s.databaseTableDetailPosition);
  const setDatabaseSettings = useSettingsStore((s) => s.setDatabaseSettings);

  const {
    tablePreview: preview,
    tableColumnMeta: colMeta,
    tabDirtyRows: tabDirtyRowsForTab,
    isCommitting,
    canUndoDirty,
    canRedoDirty,
  } = useDbTabWorkspaceSliceOrMirror(tab.id);

  /** 转置模式下预览面板默认位置与正常相反：right↔bottom，使横向布局下详情面板落在更自然的方位 */
  const transposed = preview?.transposed ?? false;
  const effectiveDetailPosition: DatabaseTableDetailPosition = transposed
    ? detailPosition === "right"
      ? "bottom"
      : "right"
    : detailPosition;

  const canRefresh = tab.connId && tab.dbName && tab.tableName;

  const statusBarInfo = useMemo(() => {
    if (!tab.dbName || !tab.tableName) return null;
    const tableLabel = `${tab.dbName}.${tab.tableName}`;
    const rowCount = preview?.totalRows;
    return (
      <>
        <span className="statusbar-item statusbar-item--truncate" title={tableLabel}>
          {tableLabel}
        </span>
        {rowCount != null ? (
          <span className="statusbar-item">
            {rowCount.toLocaleString()} {t("common.rows")}
          </span>
        ) : null}
      </>
    );
  }, [preview?.totalRows, tab.dbName, tab.tableName, t]);

  const previewConnection = tab.connId ? ws.resolveConnection(tab.connId) : null;
  const databaseSchema = useTreeChartDatabaseSchema(
    active ? previewConnection : null,
    active ? (tab.dbName ?? "") : "",
  );
  const relationTables = useMemo(
    () => databaseSchema?.tables.filter((table) => table.kind !== "view") ?? [],
    [databaseSchema],
  );
  const canInsertRow = !!(
    canRefresh &&
    preview?.data &&
    colMeta?.length &&
    previewConnection &&
    connectionHasTableSchemaChildren(previewConnection)
  );

  const canDeleteRow = !!(canInsertRow && previewConnection.db_type !== "redis");

  const pkCols = useMemo(() => colMeta?.filter((col) => col.isPk) ?? [], [colMeta]);

  const deletedRowKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const key of Object.keys(tabDirtyRowsForTab)) {
      if (isDeletedRowDirtyKey(key)) {
        keys.add(key.slice(DELETED_ROW_KEY_PREFIX.length));
      }
    }
    return keys;
  }, [tabDirtyRowsForTab]);

  /** 展示用脏行 key：删除标记映射为原始行 key，便于网格高亮匹配 */
  const previewDirtyRowKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const key of Object.keys(tabDirtyRowsForTab)) {
      if (isDeletedRowDirtyKey(key)) {
        keys.add(key.slice(DELETED_ROW_KEY_PREFIX.length));
      } else {
        keys.add(key);
      }
    }
    return keys;
  }, [tabDirtyRowsForTab]);
  const previewCellOverrides = tabDirtyRowsForTab;

  const pendingInsertCount = useMemo(
    () => Object.keys(tabDirtyRowsForTab).filter(isNewRowDirtyKey).length,
    [tabDirtyRowsForTab],
  );

  const previewDisplayRows = useMemo(() => {
    if (!preview?.data || !colMeta) return preview?.data?.rows ?? [];
    const dirty = tabDirtyRowsForTab;
    const pendingRows = Object.entries(dirty)
      .filter(([key]) => isNewRowDirtyKey(key))
      .map(([key, changes]) => {
        const row: Record<string, unknown> = { [PENDING_INSERT_ROW_KEY]: key };
        for (const column of colMeta) {
          row[column.name] = changes[column.name] ?? null;
        }
        return row;
      });
    // 无待插入行且不过滤时复用原 rows 引用，避免每次 dirty 换引用拖垮关联 lookup / 网格
    if (pendingRows.length === 0 && changeRowFilter === "all") {
      return preview.data.rows;
    }
    // 待删除行保留展示，用红色高亮；不再从列表中隐藏
    const merged = [...preview.data.rows, ...pendingRows];
    if (changeRowFilter === "all") return merged;
    return merged.filter((row) => {
      const rowKey = resolvePreviewRowKey(row, pkCols);
      const kind = resolvePreviewRowChangeKind(rowKey, deletedRowKeys, previewDirtyRowKeys);
      return matchesPreviewChangeRowFilter(kind, changeRowFilter);
    });
  }, [
    preview?.data,
    colMeta,
    tabDirtyRowsForTab,
    pkCols,
    deletedRowKeys,
    previewDirtyRowKeys,
    changeRowFilter,
  ]);

  const previewColumns = useMemo(() => {
    const fromData = preview?.data?.columns ?? [];
    if (fromData.length > 0) {
      return fromData;
    }
    return colMeta?.map((col) => col.name) ?? [];
  }, [preview?.data?.columns, colMeta]);

  const canExport = Boolean(preview?.data && previewConnection);

  const activeCellKey = useMemo(() => {
    if (activeCell) {
      const rowKey = resolvePreviewRowKey(activeCell.row, pkCols);
      return `${rowKey}:${activeCell.column}`;
    }
    if (selectedCells.length > 1) {
      return `multi:${selectedCells.length}`;
    }
    return null;
  }, [activeCell, pkCols, selectedCells.length]);

  const editorColumnName = activeCell?.column ?? selectedCells[0]?.column ?? null;
  const editorSelectionCount = selectedCells.length;

  const activeColumnMeta = useMemo(
    () => (editorColumnName ? colMeta?.find((col) => col.name === editorColumnName) : undefined),
    [editorColumnName, colMeta],
  );

  const activeCellValue = useMemo(() => {
    if (!activeCell) return undefined;
    const rowKey = resolvePreviewRowKey(activeCell.row, pkCols);
    const override = rowKey ? previewCellOverrides[rowKey]?.[activeCell.column] : undefined;
    return override !== undefined ? override : activeCell.row[activeCell.column];
  }, [activeCell, pkCols, previewCellOverrides]);

  const activeRow = useMemo(() => {
    const cell = activeCell ?? selectedCells[0] ?? null;
    return cell?.row ?? null;
  }, [activeCell, selectedCells]);

  const activeRowOverrides = useMemo(() => {
    if (!activeRow) return undefined;
    const rowKey = resolvePreviewRowKey(activeRow, pkCols);
    return rowKey ? previewCellOverrides[rowKey] : undefined;
  }, [activeRow, pkCols, previewCellOverrides]);

  const activeCellRef = useRef<TableDataGridActiveCell | null>(null);
  const selectedCellsKeyRef = useRef<string | undefined>(undefined);

  const handleActiveCellChange = useCallback((cell: TableDataGridActiveCell | null) => {
    const prevKey = selectionTargetKey(activeCellRef.current);
    const nextKey = selectionTargetKey(cell);
    if (prevKey === nextKey) return;
    if (prevKey != null && nextKey != null) {
      cellEditorRef.current?.commitIfDirty();
    }
    activeCellRef.current = cell;
    setActiveCell(cell);
  }, []);

  const handleSelectedCellsChange = useCallback((cells: TableDataGridActiveCell[]) => {
    const nextKey = selectionTargetsKey(cells);
    if (nextKey === selectedCellsKeyRef.current) return;
    const prevKey = selectedCellsKeyRef.current;
    const prevCount = selectionTargetCount(prevKey);
    const nextCount = selectionTargetCount(nextKey);

    if (nextKey === "") {
      cellEditorRef.current?.commitIfDirty();
    } else if (prevCount > 1 && nextCount < prevCount) {
      cellEditorRef.current?.commitIfDirty();
    }

    selectedCellsKeyRef.current = nextKey;
    setSelectedCells(cells);
  }, []);

  const handlePreviewCellCommit = useCallback(
    (
      cellInfo: { rowIndex: number; column: string; row: Record<string, unknown> },
      value: unknown,
    ) => {
      ws.handleCellCommit(tab.id, cellInfo, value);
    },
    [ws.handleCellCommit, tab.id],
  );
  const handlePreviewCellSetNull = useCallback(
    (cellInfo: { rowIndex: number; column: string; row: Record<string, unknown> }) => {
      ws.handleCellSetNull(tab.id, cellInfo);
    },
    [ws.handleCellSetNull, tab.id],
  );
  const handlePreviewCellApply = useCallback(
    ({ rawText, parsed }: { rawText: string; parsed: unknown }) => {
      const multi = selectedCells.length > 1;
      if (multi && detailCollapsed) return;

      const targets = multi
        ? selectedCells
        : activeCell
          ? [activeCell]
          : selectedCells.length === 1
            ? selectedCells
            : [];
      if (targets.length === 0) return;

      for (const cell of targets) {
        const columnMeta = colMeta?.find((col) => col.name === cell.column);
        const kind = detectCellEditorKind(columnMeta?.type ?? "text");
        const value = targets.length === 1 ? parsed : parseCellValue(kind, rawText);
        ws.handleCellCommit(tab.id, cell, value);
      }
    },
    [activeCell, detailCollapsed, colMeta, selectedCells, ws.handleCellCommit, tab.id],
  );
  const handlePreviewCellSetNullActive = useCallback(() => {
    if (!activeCell) return;
    ws.handleCellSetNull(tab.id, activeCell);
  }, [activeCell, ws.handleCellSetNull, tab.id]);

  const handleRecordFieldApply = useCallback(
    (column: string, payload: { rawText: string; parsed: unknown }) => {
      if (!activeRow) return;
      ws.handleCellCommit(
        tab.id,
        { rowIndex: 0, column, row: activeRow },
        payload.parsed,
      );
    },
    [activeRow, ws.handleCellCommit, tab.id],
  );

  const handleRecordFieldSetNull = useCallback(
    (column: string) => {
      if (!activeRow) return;
      ws.handleCellSetNull(tab.id, { rowIndex: 0, column, row: activeRow });
    },
    [activeRow, ws.handleCellSetNull, tab.id],
  );

  const handlePreviewRowPaste = useCallback(
    (payload: { values: Record<string, unknown> }) => {
      ws.handleRowPaste(tab.id, payload);
    },
    [ws.handleRowPaste, tab.id],
  );
  const handlePreviewRowsDelete = useCallback(
    (rows: Array<{ rowIndex: number; row: Record<string, unknown> }>) => {
      return ws.handleRowsDelete(tab.id, rows);
    },
    [ws.handleRowsDelete, tab.id],
  );
  const handlePreviewPageChange = useCallback(
    (page: number) => {
      ws.requestTabAction({ kind: "page", tabId: tab.id, page });
    },
    [ws.requestTabAction, tab.id],
  );
  const handlePreviewSortChange = useCallback(
    (sort: SortState | null) => {
      ws.requestTabAction({ kind: "sort", tabId: tab.id, sort });
    },
    [ws.requestTabAction, tab.id],
  );
  const handlePreviewFilterChange = useCallback(
    (nextFilter: RuleGroupType | null) => {
      ws.requestTabAction({ kind: "filter", tabId: tab.id, filter: nextFilter });
    },
    [ws.requestTabAction, tab.id],
  );
  const handleHiddenColumnsChange = useCallback(
    (hiddenColumns: string[]) => {
      ws.setTableGridView(tab.id, { hiddenColumns });
    },
    [ws.setTableGridView, tab.id],
  );
  const handleTransposedChange = useCallback(
    (transposed: boolean) => {
      ws.setTableGridView(tab.id, { transposed });
    },
    [ws.setTableGridView, tab.id],
  );
  const handleColumnRelationsChange = useCallback(
    (columnRelations: Record<string, TableColumnRelationConfig>) => {
      ws.setTableGridView(tab.id, { columnRelations });
    },
    [ws.setTableGridView, tab.id],
  );

  const handleDetailCollapsedChange = useCallback(() => {
    const handle = detailPanelRef.current;
    if (!handle) {
      setDetailCollapsed((prev) => !prev);
      return;
    }
    detailCollapseSyncingRef.current = true;
    try {
      if (handle.isCollapsed()) {
        // expand() 无记忆尺寸时会落到 minSize，必须再 resize 到已存 px
        handle.expand();
        handle.resize(toPanelPx(detailSizePxByPositionRef.current[effectiveDetailPosition]));
        setDetailCollapsed(false);
      } else {
        cellEditorRef.current?.commitIfDirty();
        handle.collapse();
        setDetailCollapsed(true);
      }
    } finally {
      queueMicrotask(() => {
        detailCollapseSyncingRef.current = false;
      });
    }
  }, [effectiveDetailPosition]);

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

  const handleDetailPanelResize = useCallback(
    (panelSize: PanelSize) => {
      // 布局同步中的 onResize 勿反写 React 态，否则会把「默认收起」冲成展开
      if (detailCollapseSyncingRef.current) {
        return;
      }
      const collapsed = detailPanelRef.current?.isCollapsed() ?? false;
      setDetailCollapsed(collapsed);
      const minPx = DETAIL_MIN_SIZE_PX[effectiveDetailPosition];
      // 折叠过程中 inPixels≈0，勿覆盖用户尺寸
      if (!collapsed && panelSize.inPixels >= minPx) {
        detailSizePxByPositionRef.current[effectiveDetailPosition] = Math.round(panelSize.inPixels);
      }
    },
    [effectiveDetailPosition],
  );

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;

      if (matchesShortcut(event, getShortcutKeys("save-table-data"))) {
        if (useDbWorkspaceTabStore.getState().committingTabs.has(tab.id)) return;
        event.preventDefault();
        event.stopPropagation();
        // 先让内联/侧栏编辑器把当前值写入 dirty，再提交
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
        cellEditorRef.current?.commitIfDirty();
        window.setTimeout(() => {
          const dirty = useDbWorkspaceTabStore.getState().tabDirtyRows[tab.id];
          if (!dirty || Object.keys(dirty).length === 0) return;
          if (useDbWorkspaceTabStore.getState().committingTabs.has(tab.id)) return;
          void ws.commitTabDirty(tab.id).catch(() => {});
        }, 0);
        return;
      }

      if (matchesShortcut(event, getShortcutKeys("undo-table-data"))) {
        if (isEditableKeyboardTarget(event.target)) return;
        if (useDbWorkspaceTabStore.getState().committingTabs.has(tab.id)) return;
        const history = useDbWorkspaceTabStore.getState().tabDirtyHistory[tab.id];
        if (!history?.past.length) return;
        event.preventDefault();
        event.stopPropagation();
        ws.undoTabDirty(tab.id);
        return;
      }

      if (matchesShortcut(event, getShortcutKeys("redo-table-data"))) {
        if (isEditableKeyboardTarget(event.target)) return;
        if (useDbWorkspaceTabStore.getState().committingTabs.has(tab.id)) return;
        const history = useDbWorkspaceTabStore.getState().tabDirtyHistory[tab.id];
        if (!history?.future.length) return;
        event.preventDefault();
        event.stopPropagation();
        ws.redoTabDirty(tab.id);
        return;
      }

      if (event.key !== "Escape") return;
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
        cellEditorRef.current?.commitIfDirty();
        const handle = detailPanelRef.current;
        if (handle && !handle.isCollapsed()) {
          handle.collapse();
        }
        setDetailCollapsed(true);
        return;
      }

      if (grid?.hasSelection()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        grid.clearSelection();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [active, detailCollapsed, gridActionsRef, tab.id, ws]);

  const saveShortcutLabel = formatShortcutList(getShortcutKeys("save-table-data"));
  const undoShortcutLabel = formatShortcutList(getShortcutKeys("undo-table-data"));
  const redoShortcutLabel = formatShortcutList(getShortcutKeys("redo-table-data"));

  const handlePositionChange = useCallback(
    (position: DatabaseTableDetailPosition) => {
      // position 是视觉（effective）位置；转置模式下写回 store 需反向，使转置回去后恢复原方位
      const storePosition: DatabaseTableDetailPosition = transposed
        ? position === "right"
          ? "bottom"
          : "right"
        : position;
      setDatabaseSettings({ databaseTableDetailPosition: storePosition });
    },
    [setDatabaseSettings, transposed],
  );

  const handleCreateTableQuery = useCallback(() => {
    if (!previewConnection || !canRefresh) {
      return;
    }
    ws.openTableQuery({
      connId: tab.connId,
      dbName: tab.dbName,
      tableName: tab.tableName,
      connection: previewConnection,
    });
  }, [canRefresh, previewConnection, tab.connId, tab.dbName, tab.tableName, ws]);

  const handleOpenTableDesign = useCallback(() => {
    if (!previewConnection || !canRefresh) {
      return;
    }
    ws.openTableDesigner({
      connId: tab.connId,
      dbName: tab.dbName,
      tableName: tab.tableName,
      connection: previewConnection,
    });
  }, [canRefresh, previewConnection, tab.connId, tab.dbName, tab.tableName, ws]);

  const canDesignTable = Boolean(previewConnection && supportsTableDesign(previewConnection));
  const canShowDdl = Boolean(canRefresh && previewConnection);
  const ddlOpen = !detailCollapsed && detailTab === "ddl";

  const handleToggleDdl = useCallback(() => {
    if (ddlOpen) {
      handleDetailCollapsedChange();
      return;
    }
    setDetailTab("ddl");
    if (detailCollapsed) {
      expandDetailPanel();
    }
  }, [ddlOpen, detailCollapsed, expandDetailPanel, handleDetailCollapsedChange]);

  // 切换表时清空 DDL，打开 DDL 页签时再拉
  useEffect(() => {
    setDdlEntry({ status: "idle" });
  }, [tab.connId, tab.dbName, tab.tableName]);

  useEffect(() => {
    if (!ddlOpen || !previewConnection || !tab.connId || !tab.dbName || !tab.tableName) {
      return;
    }

    let cancelled = false;
    const cached = readTableDdlCache(tab.connId, tab.dbName, tab.tableName, previewConnection);
    if (cached) {
      setDdlEntry({ status: "loaded", ddl: cached });
      return;
    }

    setDdlEntry({ status: "loading" });
    void (async () => {
      try {
        const raw = await fetchTableDdl(previewConnection, tab.dbName, tab.tableName);
        if (cancelled) return;
        const formatted = formatSqlDdl(raw, previewConnection.db_type);
        writeTableDdlCache(
          tab.connId,
          tab.dbName,
          tab.tableName,
          previewConnection,
          formatted,
        );
        setDdlEntry({ status: "loaded", ddl: formatted });
      } catch (err) {
        if (cancelled) return;
        setDdlEntry({
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [ddlOpen, previewConnection, tab.connId, tab.dbName, tab.tableName]);

  const handleCopyDdl = useCallback(async () => {
    if (ddlEntry.status !== "loaded" || !ddlEntry.ddl) {
      return;
    }
    try {
      await navigator.clipboard.writeText(ddlEntry.ddl);
      showToast(t("database.contextMenu.copyDdlDone"));
    } catch {
      showToast(t("database.contextMenu.copyDdlFailed"));
    }
  }, [ddlEntry, t]);

  const splitDirection = effectiveDetailPosition === "right" ? "horizontal" : "vertical";
  const detailDefaultSize = toPanelPx(DETAIL_DEFAULT_SIZE_PX[effectiveDetailPosition]);
  const detailMinSize = toPanelPx(DETAIL_MIN_SIZE_PX[effectiveDetailPosition]);

  const previewSql = useMemo(() => {
    if (!previewConnection || !tab.tableName || !preview) return "";
    const dbType = previewConnection.db_type;
    const visible = previewColumns.filter(
      (column) => !isRelationDisplayColumn(column) || preview.columnRelations[relationSourceColumn(column) ?? ""],
    );
    const hasRelation = visible.some((column) => isRelationDisplayColumn(column));
    if (hasRelation) {
      return buildTablePreviewSqlWithRelations({
        dbType,
        tableName: tab.tableName,
        filter: preview.filter,
        sort: preview.sort,
        page: preview.page,
        pageSize: preview.pageSize,
        columnRelations: preview.columnRelations,
        relationTables,
        visibleGridColumns: visible,
        columnMeta: colMeta ?? undefined,
      });
    }
    return buildTablePreviewSql({
      dbType,
      tableName: tab.tableName,
      filter: preview.filter,
      sort: preview.sort,
      page: preview.page,
      pageSize: preview.pageSize,
      columnMeta: colMeta ?? undefined,
    });
  }, [previewConnection, tab.tableName, preview, previewColumns, relationTables, colMeta]);

  const handleCopyPreviewSql = useCallback(async () => {
    if (gridActionsRef.current) {
      gridActionsRef.current.copyPreviewSql();
      return;
    }
    if (!previewSql) return;
    try {
      await navigator.clipboard.writeText(previewSql);
      setCopySqlHint(true);
      if (copySqlHintTimerRef.current != null) {
        window.clearTimeout(copySqlHintTimerRef.current);
      }
      copySqlHintTimerRef.current = window.setTimeout(() => {
        setCopySqlHint(false);
        copySqlHintTimerRef.current = null;
      }, 2000);
    } catch {
      showToast("复制失败");
    }
  }, [previewSql, t]);

  useEffect(() => {
    return () => {
      if (copySqlHintTimerRef.current != null) {
        window.clearTimeout(copySqlHintTimerRef.current);
      }
    };
  }, []);

  const dirtyCount = Object.keys(tabDirtyRowsForTab).length;
  const totalPages = preview
    ? Math.max(1, Math.ceil(Math.max(preview.totalRows, 1) / preview.pageSize))
    : 1;

  const enableFilter = Boolean(
    previewConnection &&
      previewConnection.db_type !== "redis" &&
      (colMeta?.length ?? 0) > 0,
  );

  const hasPreviewColumns = previewColumns.length > 0;
  /** 打开表后立刻出壳：顶栏/查询栏不必等行数据 */
  const showShell = Boolean(
    preview &&
      !preview.error &&
      canRefresh &&
      (preview.data || preview.loading || hasPreviewColumns),
  );
  /**
   * 对齐 dbx：有列就挂网格壳（可空行），数据到达只改 rows，不拆不装。
   * 晚挂载会把「首挂成本」叠在 IPC 回包上；先挂空壳把成本摊到等网络期间。
   */
  const hasPreviewData = Boolean(preview?.data);
  const deferredDisplayRows = useDeferredValue(previewDisplayRows);
  const showPreviewGrid = Boolean(
    showShell && gridMounted && (hasPreviewColumns || hasPreviewData),
  );
  const showGridSkeleton = Boolean(showShell && !showPreviewGrid && preview?.loading);

  // 切换右/底、或 Tab 重新激活时同步展开态（Dock 可能刚挂载），并用该方位已记住的 px
  useLayoutEffect(() => {
    if (!showPreviewGrid || !active) return;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅形态/激活时同步，保留当前 collapsed
  }, [effectiveDetailPosition, showPreviewGrid, active]);

  // 勿用 active 卸载网格/详情：Dock keep-alive 下卸载再挂载会明显「闪加载」
  const detailPanel = (
    <TableDetailPanel
      activeTab={detailTab}
      onActiveTabChange={setDetailTab}
      position={effectiveDetailPosition}
      onPositionChange={handlePositionChange}
      collapsed={detailCollapsed}
      onToggleCollapsed={handleDetailCollapsedChange}
      columns={previewColumns}
      columnMeta={colMeta}
      activeRow={activeRow}
      cellOverrides={activeRowOverrides}
      onRecordFieldApply={handleRecordFieldApply}
      onRecordFieldSetNull={canInsertRow ? handleRecordFieldSetNull : undefined}
      cellEditorRef={cellEditorRef}
      cellKey={activeCellKey}
      columnName={editorColumnName}
      columnType={editorSelectionCount > 1 ? "text" : (activeColumnMeta?.type ?? "text")}
      currentValue={editorSelectionCount > 1 ? "" : activeCellValue}
      selectionCount={editorSelectionCount}
      editorOpen={Boolean(active) && !detailCollapsed}
      rowIndex={activeCell?.rowIndex ?? null}
      valueColumnMeta={editorSelectionCount > 1 ? null : (activeColumnMeta ?? null)}
      dbType={previewConnection?.db_type}
      onValueApply={handlePreviewCellApply}
      onValueSetNull={activeCell ? handlePreviewCellSetNullActive : undefined}
      showDdlTab={canShowDdl}
      ddlTitle={
        tab.dbName && tab.tableName
          ? `${tab.dbName}.${tab.tableName}`
          : tab.tableName || undefined
      }
      ddlState={ddlEntry}
      onCopyDdl={() => void handleCopyDdl()}
    />
  );

  const previewGrid = showPreviewGrid && preview ? (
    <TableDataGrid
      columns={previewColumns}
      rows={hasPreviewData ? deferredDisplayRows : []}
      totalRows={(preview.totalRows ?? 0) + pendingInsertCount}
      page={preview.page}
      pageSize={preview.pageSize}
      loading={Boolean(preview.loading) || (hasPreviewColumns && !hasPreviewData)}
      columnMeta={colMeta}
      chromePlacement="none"
      gridActionsRef={gridActionsRef}
      rowSourceTabId={tab.id}
      onSelectedRowCountChange={setSelectedRowCount}
      enableTranspose
      enableSort={hasPreviewColumns}
      sort={preview.sort ?? null}
      onSortChange={handlePreviewSortChange}
      enableFilter={enableFilter}
      filter={preview.filter ?? null}
      onFilterChange={handlePreviewFilterChange}
      onCellCommit={handlePreviewCellCommit}
      onActiveCellChange={handleActiveCellChange}
      onSelectedCellsChange={handleSelectedCellsChange}
      onCellSetNull={handlePreviewCellSetNull}
      onRowPaste={canInsertRow ? handlePreviewRowPaste : undefined}
      onDeleteSelectedRows={canDeleteRow ? handlePreviewRowsDelete : undefined}
      dirtyRowKeys={previewDirtyRowKeys}
      deletedRowKeys={deletedRowKeys}
      cellOverrides={previewCellOverrides}
      onPageChange={handlePreviewPageChange}
      dbType={previewConnection?.db_type}
      tableName={tab.tableName}
      hiddenColumns={preview.hiddenColumns}
      onHiddenColumnsChange={handleHiddenColumnsChange}
      transposed={preview.transposed}
      onTransposedChange={handleTransposedChange}
      cellEditorCollapsed={detailCollapsed}
      reserveSelectionOnEscape
      onCellEditorFocusRequest={handleCellEditorFocusRequest}
      onRowBandSelect={handleRowBandSelect}
      relationTables={relationTables}
      relationConnection={previewConnection ?? undefined}
      relationDatabase={tab.dbName ?? undefined}
      columnRelations={preview.columnRelations}
      onColumnRelationsChange={handleColumnRelationsChange}
      statusBarActionPanelId={tab.id}
      statusBarInfo={statusBarInfo}
      onExportMenu={
        canExport ? (x, y) => ws.openExportMenu(x, y, tab.id) : undefined
      }
      onOpenRowDetail={() => {
        setDetailTab("record");
        expandDetailPanel();
      }}
    />
  ) : null;

  const gridSkeleton = showGridSkeleton ? (
    <div className="db-table-preview-skeleton" aria-busy="true" aria-label={t("common.loading")}>
      <div className="db-table-preview-skeleton__header">
        {hasPreviewColumns ? (
          previewColumns.slice(0, 16).map((name) => (
            <span key={name} className="db-table-preview-skeleton__col-label" title={name}>
              {name}
            </span>
          ))
        ) : (
          <>
            <span className="db-table-preview-skeleton__bar db-table-preview-skeleton__bar--sm" />
            <span className="db-table-preview-skeleton__bar db-table-preview-skeleton__bar--md" />
            <span className="db-table-preview-skeleton__bar db-table-preview-skeleton__bar--lg" />
            <span className="db-table-preview-skeleton__bar db-table-preview-skeleton__bar--md" />
            <span className="db-table-preview-skeleton__bar db-table-preview-skeleton__bar--sm" />
          </>
        )}
      </div>
      {Array.from({ length: 8 }, (_, index) => (
        <div key={index} className="db-table-preview-skeleton__row">
          <span className="db-table-preview-skeleton__bar db-table-preview-skeleton__bar--xs" />
          <span className="db-table-preview-skeleton__bar db-table-preview-skeleton__bar--lg" />
          <span className="db-table-preview-skeleton__bar db-table-preview-skeleton__bar--md" />
          <span className="db-table-preview-skeleton__bar db-table-preview-skeleton__bar--sm" />
          <span className="db-table-preview-skeleton__bar db-table-preview-skeleton__bar--md" />
        </div>
      ))}
    </div>
  ) : null;

  return (
    <div className="db-workspace-pane db-workspace-pane--data">
      {preview?.error ? (
        <div
          className="empty-state compact text-danger"
          style={{ padding: "var(--sp-4)", whiteSpace: "pre-wrap" }}
        >
          {preview.error}
        </div>
      ) : showShell && preview ? (
        <div className="db-table-preview-shell">
          <TablePreviewTopBar
            loading={preview.loading}
            page={preview.page}
            pageSize={preview.pageSize}
            totalRows={(preview.totalRows ?? 0) + pendingInsertCount}
            totalPages={totalPages}
            dirtyCount={dirtyCount}
            isCommitting={isCommitting}
            canUndoDirty={canUndoDirty}
            canRedoDirty={canRedoDirty}
            canInsertRow={canInsertRow}
            canDeleteRow={canDeleteRow}
            hasSelectedRows={selectedRowCount > 0}
            selectedRowCount={selectedRowCount}
            canExport={canExport}
            canDesignTable={canDesignTable}
            canCreateTableQuery={Boolean(canRefresh && previewConnection)}
            transposed={preview.transposed}
            detailCollapsed={detailCollapsed}
            colSidebarCollapsed={colSidebarCollapsed}
            onPageChange={handlePreviewPageChange}
            onRefresh={() => ws.requestTabAction({ kind: "refresh", tabId: tab.id })}
            onInsertRow={() => ws.handleRowNew(tab.id)}
            onDeleteSelectedRows={() => gridActionsRef.current?.deleteSelectedRows()}
            onUndoAll={() => ws.rollbackTabDirty(tab.id)}
            onUndo={() => ws.undoTabDirty(tab.id)}
            onRedo={() => ws.redoTabDirty(tab.id)}
            onCommit={() => {
              ws.commitTabDirty(tab.id).catch(() => {});
            }}
            saveShortcutHint={saveShortcutLabel}
            undoShortcutHint={undoShortcutLabel}
            redoShortcutHint={redoShortcutLabel}
            onExport={(x, y) => ws.openExportMenu(x, y, tab.id)}
            onTransposeToggle={() => handleTransposedChange(!preview.transposed)}
            onToggleColSidebar={() => {
              gridActionsRef.current?.toggleColSidebar();
              setColSidebarCollapsed((prev) => !prev);
            }}
            onToggleDetail={handleDetailCollapsedChange}
            ddlOpen={ddlOpen}
            canShowDdl={canShowDdl}
            onToggleDdl={handleToggleDdl}
            onOpenTableDesign={handleOpenTableDesign}
            onCreateTableQuery={handleCreateTableQuery}
            onCopyPreviewSql={() => void handleCopyPreviewSql()}
            copySqlHint={copySqlHint}
            previewSqlTitle={previewSql}
          />
          <TablePreviewQueryBar
            dbType={previewConnection?.db_type ?? "mysql"}
            columnMeta={colMeta}
            filter={preview.filter}
            sort={preview.sort}
            onFilterChange={handlePreviewFilterChange}
            onSortChange={handlePreviewSortChange}
            enableFilter={enableFilter}
            changeRowFilter={changeRowFilter}
            onChangeRowFilterChange={setChangeRowFilter}
          />
          <DockLayout
            direction={splitDirection}
            className={`db-table-preview-split db-table-preview-split--${effectiveDetailPosition}`}
          >
            <DockPanel minSize="160px">
              <div className="results-area db-sql-results">
                {previewGrid ?? gridSkeleton}
              </div>
            </DockPanel>
            <DockHandle direction={splitDirection} />
            <DockPanel
              // 默认收起时必须以 0 挂载；若用 detailDefaultSize，首帧会展开并由 onResize 把状态冲成打开
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
      ) : (
        <div className="empty-state compact" style={{ flex: 1, padding: "var(--sp-4)" }}>
          {t("common.loading")}
        </div>
      )}
    </div>
  );
});
