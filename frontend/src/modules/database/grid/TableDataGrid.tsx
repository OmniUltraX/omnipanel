import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  memo,
  type ReactNode,
  type MutableRefObject,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnSizingState,
} from "@tanstack/react-table";
import type { RuleGroupType } from "react-querybuilder";

import { Button } from "../../../components/ui/Button";
import { WarnAlert } from "../../../components/ui/overlay/WarnAlert";
import { useI18n } from "../../../i18n";
import { type DbColumnMeta, type DbConnectionConfig } from "../api";
import { resolvePreviewRowChangeKind, resolvePreviewRowKey, type PreviewRowChangeKind, type SortState } from "../workspace/dbWorkspaceState";
import { getFilterColumnNames, buildTablePreviewSql, buildTablePreviewSqlWithRelations } from "./tablePreviewFilter";
import { showToast } from "../../../stores/toastStore";
import {
  detectCellEditorKind,
  formatInlineEditText,
  isSameCellValue,
  parseCellValue,
  resolveCellDoubleClickEditStrategy,
} from "../cell_editor";
import { TableDataGridFilterPopover } from "./TableDataGridOverlays";
import { TableDataGridCellOverlay } from "./TableDataGridCellOverlay";
import { TableColumnRelationDialog } from "./TableColumnRelationDialog";
import {
  formatColumnRelationLabel,
  buildRelationDisplayColumnLabel,
  expandColumnsWithRelations,
  isRelationDisplayColumn,
  relationDisplayColumnId,
  relationSourceColumn,
  type TableColumnRelation,
} from "./tableColumnRelation";
import {
  buildRelationLookupFingerprint,
  fetchColumnRelationLookups,
  normalizeRelationLookupKey,
} from "./columnRelationLookup";
import type { TableSchema } from "../types";
import { TableCellPreviewSubWindow } from "./TableCellPreviewSubWindow";
import {
  buildCellEditOverlay,
  buildCellPreviewOverlay,
  buildCellPreviewState,
  type CellOverlayAnchor,
  type CellOverlayState,
} from "./tableCellPreview";
import {
  ColumnFilterButton,
  ColumnHeaderLabel,
  ColumnRelationButton,
  ColumnRelationDisplayActions,
  ColumnSortIndicator,
  ColumnVisibilitySidebar,
  TableDataGridCellContextMenu,
  type TableDataGridCellMenuState,
} from "./TableDataGridChrome";
import {
  TableDataGridCellContent,
  TableDataGridTransposeFieldCell,
} from "./TableDataGridCellContent";
import {
  TableDataGridBody,
  TableDataGridVirtualBody,
  type GridBodyCellInteractionContext,
  type GridBodyStaticConfig,
  type TableDataGridBodyActions,
  type TableDataGridVirtualBodyHandle,
} from "./TableDataGridBody";
import {
  buildCellRangeClipboardText,
  buildSelectedRowsClipboardText,
  extractRowValuesFromIndex,
} from "./tableDataGridClipboard";
import {
  buildColumnNamesText,
  buildInsertSql,
  buildRowsJson,
  buildUpdateSql,
  compareCellValues,
  formatCellCopyText,
  resolveCopyColumns,
} from "./tableDataGridCopySql";
import { buildTableDataGridContextMenuItems } from "./tableDataGridContextMenu";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  COLUMN_MIN_WIDTH,
  DEFAULT_DATA_COLUMN_WIDTH,
  DEFAULT_ROW_HEIGHT,
  MIN_ROW_HEIGHT,
  ROW_NUM_COL_ID,
  ROW_VIRTUALIZE_THRESHOLD,
  TRANSPOSE_FIELD_COL,
  defaultDataColumnWidth,
  GRID_EXTERNAL_INTERACTION_SELECTOR,
} from "./tableDataGridConstants";
import {
  buildColumnVirtualizationLayout,
  buildVirtualizableColumnIndices,
  COLUMN_VIRTUALIZE_OVERSCAN,
  shouldVirtualizeGridColumns,
} from "./tableDataGridColumnVirtualization";
import { buildColumnHeaderTooltip } from "./tableDataGridFormat";
import {
  applyColumnWidthDom,
  buildColumnCellStyle,
  resetStuckPointerHover,
  scrollElementToCenter,
} from "./tableDataGridLayout";
import {
  collectSelectedRowIndices,
  collectSelectedCellTargets,
  clearDragSelectionPaint,
  isCellSelected,
  isEditableTextTarget,
  isFullRowSelection,
  isFullWidthRowRange,
  isHeaderInColumnSelection,
  normalizeRange,
  paintDragSelection,
  resolvePasteBounds,
  resolveSingleSelectedCell,
  selectionTargetKey,
  selectionTargetsKey,
  rowsInFullRowRange,
  type CellPos,
  type CellRange,
} from "./tableDataGridSelection";
import { parseClipboardMatrix } from "../shared/csvExport";
import type { DelimitedTextFormat } from "../shared/delimitedText";
import { useStatusBarActionBar } from "../../../hooks/useStatusBarActionBar";
import { useStatusBarInfoBar } from "../../../hooks/useStatusBarInfoBar";
import { TableDataGridStatusBarAction } from "./TableDataGridStatusBarAction";
import {
  resolveTransposedDataCellContext,
  transposeDirtyState,
  transposeGridData,
} from "./tableDataGridTranspose";
import type { TableDataGridActiveCell } from "./tableDataGridTypes";
export type { TableDataGridActiveCell } from "./tableDataGridTypes";

const EMPTY_DELETED_ROW_KEYS = new Set<string>();

export type TableDataGridProps = {
  columns: string[];
  rows: Record<string, unknown>[];
  totalRows: number;
  page: number;
  pageSize: number;
  loading: boolean;
  onPageChange: (page: number) => void;
  columnMeta?: DbColumnMeta[];
  onCellEdit?: (cellInfo: { rowIndex: number; column: string; row: Record<string, unknown> }) => void;
  /** 单元格内联编辑提交（数字 / 短字符串等） */
  onCellCommit?: (
    cellInfo: { rowIndex: number; column: string; row: Record<string, unknown> },
    value: unknown,
  ) => void;
  onCellSetNull?: (cellInfo: { rowIndex: number; column: string; row: Record<string, unknown> }) => void;
  /** 已修改的行 key 集合（来自父组件脏数据状态），用于高亮 */
  dirtyRowKeys?: Set<string>;
  /** 待删除行的原始 row key（不含 __delete__: 前缀） */
  deletedRowKeys?: Set<string>;
  /** 单元覆盖：行 key -> 列名 -> 覆盖值；优先于 rows 展示 */
  cellOverrides?: Record<string, Record<string, unknown>>;
  /** 显示行列转换切换按钮（表数据预览） */
  enableTranspose?: boolean;
  /** 底部分页栏左侧工具按钮（表预览操作等） */
  toolbar?: ReactNode;
  /** 当前排序状态（表预览模式） */
  sort?: SortState | null;
  /** 排序变更回调（点击列头时触发） */
  onSortChange?: (sort: SortState | null) => void;
  /** 是否启用列头排序（表预览模式） */
  enableSort?: boolean;
  /** 当前过滤规则（表预览模式） */
  filter?: RuleGroupType | null;
  /** 过滤变更回调 */
  onFilterChange?: (filter: RuleGroupType | null) => void;
  /** 是否启用列过滤（表预览模式） */
  enableFilter?: boolean;
  /** 表预览 SQL 复制：数据库类型 */
  dbType?: string;
  /** 表预览 SQL 复制：表名 */
  tableName?: string;
  /** 隐藏的列名（受控，表预览持久化） */
  hiddenColumns?: string[];
  onHiddenColumnsChange?: (hiddenColumns: string[]) => void;
  /** 行列转置（受控，表预览持久化） */
  transposed?: boolean;
  onTransposedChange?: (transposed: boolean) => void;
  /** 底部分页栏中间区域（如 SQL 结果统计、导出等） */
  footerExtra?: ReactNode;
  /**
   * 分页/工具 chrome 位置。
   * - bottom：默认，底栏完整控件（SQL 结果等）
   * - none：隐藏底栏（表预览由外层顶栏接管）
   */
  chromePlacement?: "bottom" | "none";
  /** 外层顶栏调用网格内部动作（删除选中、列侧栏、复制 SQL） */
  gridActionsRef?: MutableRefObject<TableDataGridActions | null>;
  /** 选中行数量变化（供顶栏删除徽标） */
  onSelectedRowCountChange?: (count: number) => void;
  /** 底栏值编辑器是否折叠（表预览模式） */
  cellEditorCollapsed?: boolean;
  /** 为 true 时 Escape 不清除网格选中（详情面板展开等） */
  reserveSelectionOnEscape?: boolean;
  /** 切换底栏值编辑器展开/折叠 */
  onCellEditorCollapsedChange?: () => void;
  /** 双击单元格且值编辑器展开时，请求聚焦底栏编辑器 */
  onCellEditorFocusRequest?: () => void;
  /** 点击/拖选行号选中行时回调（用于切换到记录面板等） */
  onRowBandSelect?: () => void;
  /** 粘贴为新行（表预览编辑模式） */
  onRowPaste?: (payload: { values: Record<string, unknown> }) => void;
  /** 删除选中的行（表预览编辑模式） */
  onDeleteSelectedRows?: (
    rows: Array<{ rowIndex: number; row: Record<string, unknown> }>,
  ) => void;
  /** 当前选中的单个数据单元格（用于底栏编辑器等） */
  /** 当前选中的单元格集合（含多格选区） */
  onSelectedCellsChange?: (cells: TableDataGridActiveCell[]) => void;
  onActiveCellChange?: (cell: TableDataGridActiveCell | null) => void;
  /** 快速打开表设计器（表预览底栏） */
  onOpenTableDesign?: () => void;
  canOpenTableDesign?: boolean;
  /** 快速新建以当前表为上下文的 SQL 查询 */
  onCreateTableQuery?: () => void;
  canCreateTableQuery?: boolean;
  /** 可选关联目标表（表预览模式，用于列头关联配置） */
  relationTables?: TableSchema[];
  /** 关联查询所用连接（表预览模式） */
  relationConnection?: DbConnectionConfig;
  /** 关联查询所用数据库名（表预览模式） */
  relationDatabase?: string;
  /** 列关联配置（列名 -> 目标表.字段） */
  columnRelations?: Record<string, TableColumnRelation>;
  onColumnRelationsChange?: (relations: Record<string, TableColumnRelation>) => void;
  /** 状态栏 ActionBar 绑定的 dock panelId（与 tabId 一致） */
  statusBarActionPanelId?: string;
  /** 状态栏 InfoBar 绑定的 dock panelId；缺省时与 ActionBar 相同 */
  statusBarInfoPanelId?: string;
  /** 状态栏 InfoBar 展示内容（如表名、行数） */
  statusBarInfo?: ReactNode;
  /** 打开导出菜单（表预览顶栏同源） */
  onExportMenu?: (clientX: number, clientY: number) => void;
  /** 打开行详情（记录面板） */
  onOpenRowDetail?: () => void;
};

export type TableDataGridClipboardFormat = DelimitedTextFormat;

export type TableDataGridActions = {
  deleteSelectedRows: () => void;
  toggleColSidebar: () => void;
  copyPreviewSql: () => void;
  isColSidebarCollapsed: () => boolean;
  hasInlineEdit: () => boolean;
  cancelInlineEdit: () => void;
  hasSelection: () => boolean;
  clearSelection: () => void;
};

export const TableDataGrid = memo(function TableDataGrid({
  columns,
  rows,
  totalRows,
  page,
  pageSize,
  loading,
  onPageChange,
  columnMeta,
  onCellEdit,
  onCellCommit,
  onCellSetNull,
  dirtyRowKeys,
  deletedRowKeys,
  cellOverrides,
  enableTranspose = false,
  toolbar,
  sort = null,
  onSortChange,
  enableSort = false,
  filter = null,
  onFilterChange,
  enableFilter = false,
  dbType,
  tableName,
  hiddenColumns: hiddenColumnsProp,
  onHiddenColumnsChange,
  transposed: transposedProp,
  onTransposedChange,
  footerExtra,
  chromePlacement = "bottom",
  gridActionsRef,
  onSelectedRowCountChange,
  cellEditorCollapsed = false,
  reserveSelectionOnEscape = false,
  onCellEditorCollapsedChange,
  onCellEditorFocusRequest,
  onRowBandSelect,
  onRowPaste,
  onDeleteSelectedRows,
  onSelectedCellsChange,
  onActiveCellChange,
  onOpenTableDesign,
  canOpenTableDesign = true,
  onCreateTableQuery,
  canCreateTableQuery = true,
  relationTables,
  relationConnection,
  relationDatabase,
  columnRelations: columnRelationsProp,
  onColumnRelationsChange,
  statusBarActionPanelId,
  statusBarInfoPanelId,
  statusBarInfo,
  onExportMenu,
  onOpenRowDetail,
}: TableDataGridProps) {
  const { t } = useI18n();
  const [clipboardFormat, setClipboardFormat] = useState<DelimitedTextFormat>("csv");
  const clipboardFormatRef = useRef<DelimitedTextFormat>("csv");
  clipboardFormatRef.current = clipboardFormat;
  /** 行号列读 ref，避免翻页时重建全部 columnDefs → tanstack 大更新 */
  const pageRef = useRef(page);
  const pageSizeRef = useRef(pageSize);
  pageRef.current = page;
  pageSizeRef.current = pageSize;
  /** 已有数据时的翻页：轻量态，避免整表 loading 闪烁 */
  const isPaging = loading && rows.length > 0;
  const resolvedInfoPanelId = statusBarInfoPanelId ?? statusBarActionPanelId;
  const effectiveColumns = useMemo(() => {
    if (columns.length > 0) {
      return columns;
    }
    if (columnMeta?.length) {
      return columnMeta.map((col) => col.name);
    }
    return [];
  }, [columns, columnMeta]);
  const isHiddenColumnsControlled = onHiddenColumnsChange != null;
  const isTransposedControlled = onTransposedChange != null;
  const [localHiddenColumns, setLocalHiddenColumns] = useState<Set<string>>(() => new Set());
  const [localTransposed, setLocalTransposed] = useState(false);
  const hiddenColumns = useMemo(() => {
    if (isHiddenColumnsControlled) {
      return new Set(hiddenColumnsProp ?? []);
    }
    return localHiddenColumns;
  }, [isHiddenColumnsControlled, hiddenColumnsProp, localHiddenColumns]);
  const transposed = isTransposedControlled ? (transposedProp ?? false) : localTransposed;
  const setHiddenColumns = useCallback(
    (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
      const next = typeof updater === "function" ? updater(hiddenColumns) : updater;
      if (isHiddenColumnsControlled) {
        onHiddenColumnsChange!([...next]);
        return;
      }
      setLocalHiddenColumns(next);
    },
    [hiddenColumns, isHiddenColumnsControlled, onHiddenColumnsChange],
  );
  const setTransposed = useCallback(
    (updater: boolean | ((prev: boolean) => boolean)) => {
      const next = typeof updater === "function" ? updater(transposed) : updater;
      if (isTransposedControlled) {
        onTransposedChange!(next);
        return;
      }
      setLocalTransposed(next);
    },
    [transposed, isTransposedControlled, onTransposedChange],
  );
  const [cellOverlay, setCellOverlay] = useState<CellOverlayState | null>(null);
  const cellOverlayRef = useRef(cellOverlay);
  cellOverlayRef.current = cellOverlay;
  const pinnedPreviewRef = useRef(false);
  const [colSidebarCollapsed, setColSidebarCollapsed] = useState(false);
  const [navigatedColumnId, setNavigatedColumnId] = useState<string | null>(null);
  const pendingColumnFocusRef = useRef<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterLockedField, setFilterLockedField] = useState<string | null>(null);
  const [filterAnchorRect, setFilterAnchorRect] = useState<DOMRect | null>(null);
  const [relationDialogColumn, setRelationDialogColumn] = useState<string | null>(null);
  const [relationDeleteSourceColumn, setRelationDeleteSourceColumn] = useState<string | null>(null);
  const [relationLookupMaps, setRelationLookupMaps] = useState<
    Record<string, Map<string, unknown>>
  >({});
  const [localColumnRelations, setLocalColumnRelations] = useState<
    Record<string, TableColumnRelation>
  >({});
  const isColumnRelationsControlled = onColumnRelationsChange != null;
  const columnRelations = isColumnRelationsControlled
    ? (columnRelationsProp ?? {})
    : localColumnRelations;
  const setColumnRelations = useCallback(
    (updater: (prev: Record<string, TableColumnRelation>) => Record<string, TableColumnRelation>) => {
      const next = updater(columnRelations);
      if (isColumnRelationsControlled) {
        onColumnRelationsChange!(next);
        return;
      }
      setLocalColumnRelations(next);
    },
    [columnRelations, isColumnRelationsControlled, onColumnRelationsChange],
  );
  const canConfigureRelation = Boolean(relationTables && relationTables.length > 0);
  const [copySqlHint, setCopySqlHint] = useState(false);
  const copySqlHintTimerRef = useRef<number | null>(null);
  const cellMenuOpenRef = useRef<(state: TableDataGridCellMenuState) => void>(() => {});
  const [rowHeights, setRowHeights] = useState<Record<number, number>>({});
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>({});
  const colResizeRef = useRef<{
    columnId: string;
    startX: number;
    startWidth: number;
    lastWidth: number;
  } | null>(null);
  const dragRef = useRef<{
    rowIndex: number;
    startY: number;
    startHeight: number;
    lastHeight: number;
  } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const virtualBodyRef = useRef<TableDataGridVirtualBodyHandle | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const savedScrollRef = useRef({ left: 0, top: 0 });
  const restoreScrollAfterPageChangeRef = useRef(false);
  const [cellRange, setCellRange] = useState<CellRange | null>(null);
  const [selectedRows, setSelectedRows] = useState<Set<number>>(() => new Set());
  const cellRangeRef = useRef(cellRange);
  cellRangeRef.current = cellRange;
  const selectedRowsRef = useRef(selectedRows);
  selectedRowsRef.current = selectedRows;
  const rowAnchorRef = useRef<number | null>(null);
  const cellAnchorRef = useRef<CellPos | null>(null);
  const cellDragRef = useRef<{ active: boolean; start: CellPos } | null>(null);
  const rowDragRef = useRef<{ active: boolean; startRow: number; maxCol: number } | null>(null);
  const pendingDragRangeRef = useRef<CellRange | null>(null);
  const dragSelectionRafRef = useRef<number | null>(null);
  const bodyActionsRef = useRef<TableDataGridBodyActions | null>(null);
  const hoverResetPendingRef = useRef(false);
  const copiedRowRef = useRef<Record<string, unknown> | null>(null);
  const activeCellNotifyKeyRef = useRef<string | null | undefined>(undefined);
  const selectedCellsNotifyKeyRef = useRef<string | undefined>(undefined);
  const autoIncrementPlaceholder = t("database.rowEditor.autoIncrementPlaceholder");

  useStatusBarInfoBar(
    resolvedInfoPanelId ?? "",
    resolvedInfoPanelId && statusBarInfo != null ? () => statusBarInfo : null,
    Boolean(resolvedInfoPanelId && statusBarInfo != null),
    [statusBarInfo],
  );

  useStatusBarActionBar(
    statusBarActionPanelId ?? "",
    statusBarActionPanelId
      ? () => (
          <TableDataGridStatusBarAction
            format={clipboardFormat}
            onFormatChange={setClipboardFormat}
          />
        )
      : null,
    Boolean(statusBarActionPanelId),
    [clipboardFormat],
    { summary: clipboardFormat.toUpperCase() },
  );

  const clearGridSelection = useCallback(() => {
    if (
      !cellRangeRef.current &&
      selectedRowsRef.current.size === 0 &&
      !cellDragRef.current &&
      !rowDragRef.current
    ) {
      return;
    }
    setCellRange(null);
    setSelectedRows(new Set());
    rowAnchorRef.current = null;
    cellAnchorRef.current = null;
    cellDragRef.current = null;
    rowDragRef.current = null;
    pendingDragRangeRef.current = null;
    activeCellNotifyKeyRef.current = undefined;
    selectedCellsNotifyKeyRef.current = undefined;
    const wrap = wrapRef.current;
    if (wrap) {
      clearDragSelectionPaint(wrap);
      wrap.classList.remove("db-data-table-wrap--cell-dragging");
    }
  }, []);

  useEffect(() => {
    const onDocumentMouseDown = (event: MouseEvent) => {
      const wrap = wrapRef.current;
      if (!wrap) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (wrap.contains(target)) return;
      if (target instanceof Element && target.closest(GRID_EXTERNAL_INTERACTION_SELECTOR)) {
        return;
      }
      if (
        pinnedPreviewRef.current &&
        cellOverlayRef.current?.mode === "preview" &&
        target instanceof Element &&
        !target.closest(".db-data-table-cell-overlay")
      ) {
        pinnedPreviewRef.current = false;
        setCellOverlay(null);
        return;
      }
      clearGridSelection();
    };
    document.addEventListener("mousedown", onDocumentMouseDown, true);
    return () => document.removeEventListener("mousedown", onDocumentMouseDown, true);
  }, [clearGridSelection]);

  useEffect(() => {
    if (loading) {
      setCellOverlay(null);
      hoverResetPendingRef.current = true;
      return;
    }
    if (!hoverResetPendingRef.current) return;
    let innerRaf = 0;
    const outerRaf = requestAnimationFrame(() => {
      innerRaf = requestAnimationFrame(() => {
        hoverResetPendingRef.current = false;
      });
    });
    return () => {
      cancelAnimationFrame(outerRaf);
      if (innerRaf) cancelAnimationFrame(innerRaf);
    };
  }, [loading]);

  const handlePageChange = useCallback(
    (nextPage: number) => {
      setCellRange(null);
      setSelectedRows(new Set());
      rowAnchorRef.current = null;
      cellAnchorRef.current = null;
      cellDragRef.current = null;
      const el = wrapRef.current;
      if (el) {
        savedScrollRef.current = { left: el.scrollLeft, top: el.scrollTop };
      }
      restoreScrollAfterPageChangeRef.current = true;
      onPageChange(nextPage);
    },
    [onPageChange],
  );

  useLayoutEffect(() => {
    if (!restoreScrollAfterPageChangeRef.current) return;
    restoreScrollAfterPageChangeRef.current = false;
    const el = wrapRef.current;
    if (!el) return;
    const { left, top } = savedScrollRef.current;
    el.scrollLeft = left;
    el.scrollTop = top;
  }, [page, rows]);

  useEffect(() => {
    setRowHeights({});
    setCellRange(null);
    setSelectedRows(new Set());
    rowAnchorRef.current = null;
    cellAnchorRef.current = null;
    cellDragRef.current = null;
    dragRef.current = null;
    colResizeRef.current = null;
    wrapRef.current?.classList.remove("db-data-table-wrap--resizing", "db-data-table-wrap--col-resizing");
  }, [effectiveColumns, transposed]);

  useEffect(() => {
    setHiddenColumns((prev) => {
      if (prev.size === 0) return prev;
      const valid = new Set(transposed ? effectiveColumns : expandColumnsWithRelations(effectiveColumns, columnRelations));
      let changed = false;
      const next = new Set<string>();
      for (const name of prev) {
        if (valid.has(name)) {
          next.add(name);
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [effectiveColumns, columnRelations, transposed]);

  const pkCols = useMemo(() => (columnMeta ?? []).filter((c) => c.isPk), [columnMeta]);
  const pkCount = pkCols.length;

  const openCellPreview = useCallback(
    (info: {
      column: string;
      rowIndex: number;
      row: Record<string, unknown>;
      value: unknown;
      columnType?: string;
      anchor?: CellOverlayAnchor;
    }) => {
      const resolvedAnchor = info.anchor ?? {
        left: window.innerWidth / 2 - 140,
        top: window.innerHeight / 2 - 80,
        width: 280,
        height: 32,
      };
      pinnedPreviewRef.current = true;
      setCellOverlay(
        buildCellPreviewOverlay(resolvedAnchor, {
          column: info.column,
          rowIndex: info.rowIndex,
          row: info.row,
          value: info.value,
          columnType: info.columnType,
        }, { pinned: true }),
      );
    },
    [],
  );

  const closeCellPreview = useCallback(() => {
    pinnedPreviewRef.current = false;
    setCellOverlay((prev) => (prev?.mode === "preview" ? null : prev));
  }, []);

  const cellPreviewState = useMemo(
    () => (cellOverlay?.mode === "preview" ? buildCellPreviewState(cellOverlay) : null),
    [cellOverlay],
  );
  const cellPreviewOpenRef = useRef(false);
  cellPreviewOpenRef.current = cellPreviewState != null;
  const reserveSelectionOnEscapeRef = useRef(reserveSelectionOnEscape);
  reserveSelectionOnEscapeRef.current = reserveSelectionOnEscape;
  const filterColumnNames = useMemo(() => getFilterColumnNames(filter), [filter]);
  const canFilter = enableFilter && Boolean(onFilterChange && columnMeta?.length);

  const openFilterPopover = useCallback((anchor: HTMLElement, lockedField: string) => {
    setFilterAnchorRect(anchor.getBoundingClientRect());
    setFilterLockedField(lockedField);
    setFilterOpen(true);
  }, []);

  const openRelationDialog = useCallback((columnName: string) => {
    setRelationDialogColumn(columnName);
  }, []);

  const handleRelationConfirm = useCallback(
    (relation: TableColumnRelation | null) => {
      if (!relationDialogColumn) return;
      setColumnRelations((prev) => {
        const next = { ...prev };
        if (relation) {
          next[relationDialogColumn] = relation;
        } else {
          delete next[relationDialogColumn];
        }
        return next;
      });
      setRelationDialogColumn(null);
    },
    [relationDialogColumn, setColumnRelations],
  );

  const handleRelationDeleteConfirm = useCallback(() => {
    if (!relationDeleteSourceColumn) return;
    setColumnRelations((prev) => {
      const next = { ...prev };
      delete next[relationDeleteSourceColumn];
      return next;
    });
    setRelationDeleteSourceColumn(null);
  }, [relationDeleteSourceColumn, setColumnRelations]);

  const canCopyPreviewSql = Boolean(dbType && tableName);

  const gridColumns = useMemo(() => {
    if (transposed) return effectiveColumns;
    return expandColumnsWithRelations(effectiveColumns, columnRelations);
  }, [effectiveColumns, columnRelations, transposed]);

  const visibleColumns = useMemo(
    () => {
      if (hiddenColumns.size === 0) return gridColumns;
      return gridColumns.filter((column) => {
        if (hiddenColumns.has(column)) return false;
        if (isRelationDisplayColumn(column)) {
          const sourceColumn = relationSourceColumn(column);
          return sourceColumn ? !hiddenColumns.has(sourceColumn) : true;
        }
        return true;
      });
    },
    [gridColumns, hiddenColumns],
  );

  const relationHighlightColumnIds = useMemo(() => {
    const ids = new Set<string>();
    for (const sourceColumn of Object.keys(columnRelations)) {
      ids.add(sourceColumn);
      ids.add(relationDisplayColumnId(sourceColumn));
    }
    return ids;
  }, [columnRelations]);

  const sidebarColumns = transposed ? effectiveColumns : gridColumns;

  const sidebarColumnLabels = useMemo(() => {
    const labels: Record<string, string> = {};
    for (const column of sidebarColumns) {
      if (isRelationDisplayColumn(column)) {
        const sourceColumn = relationSourceColumn(column);
        const relation = sourceColumn ? columnRelations[sourceColumn] : undefined;
        const relatedTable = relation
          ? relationTables?.find((table) => table.name === relation.tableName)
          : undefined;
        labels[column] = relation
          ? buildRelationDisplayColumnLabel(relation, relatedTable)
          : column;
      } else {
        labels[column] = column;
      }
    }
    return labels;
  }, [sidebarColumns, columnRelations, relationTables]);

  const isSidebarColumnVisible = useCallback(
    (columnName: string) => {
      if (hiddenColumns.has(columnName)) return false;
      if (isRelationDisplayColumn(columnName)) {
        const sourceColumn = relationSourceColumn(columnName);
        return sourceColumn ? !hiddenColumns.has(sourceColumn) : true;
      }
      return true;
    },
    [hiddenColumns],
  );

  const sidebarColumnItemClassName = useCallback(
    (columnName: string) => {
      if (isRelationDisplayColumn(columnName)) {
        return "db-col-visibility-popover-item--relation-display";
      }
      if (columnRelations[columnName]) {
        return "db-col-visibility-popover-item--relation";
      }
      return undefined;
    },
    [columnRelations],
  );

  const resolveRelationSourceValue = useCallback(
    (row: Record<string, unknown>, sourceColumn: string) => {
      const rowKey = resolvePreviewRowKey(row, pkCols);
      const override = rowKey ? cellOverrides?.[rowKey]?.[sourceColumn] : undefined;
      return override !== undefined ? override : row[sourceColumn];
    },
    [pkCols, cellOverrides],
  );

  const relationLookupFingerprint = useMemo(
    () =>
      buildRelationLookupFingerprint(columnRelations, rows, (row, sourceColumn) =>
        resolveRelationSourceValue(row, sourceColumn),
      ),
    [columnRelations, rows, resolveRelationSourceValue],
  );

  const rowsWithRelationDisplay = useMemo(() => {
    if (transposed || Object.keys(columnRelations).length === 0) return rows;
    return rows.map((row) => {
      const extra: Record<string, unknown> = {};
      for (const sourceColumn of Object.keys(columnRelations)) {
        const displayColumnId = relationDisplayColumnId(sourceColumn);
        if (row[displayColumnId] !== undefined) {
          extra[displayColumnId] = row[displayColumnId];
          continue;
        }
        const lookupMap = relationLookupMaps[displayColumnId];
        const sourceValue = resolveRelationSourceValue(row, sourceColumn);
        if (sourceValue == null || sourceValue === "") {
          extra[displayColumnId] = null;
          continue;
        }
        extra[displayColumnId] =
          lookupMap?.get(normalizeRelationLookupKey(sourceValue)) ?? null;
      }
      return { ...row, ...extra };
    });
  }, [rows, columnRelations, relationLookupMaps, transposed, resolveRelationSourceValue]);

  const rowsForRelationLookupRef = useRef(rows);
  rowsForRelationLookupRef.current = rows;
  const resolveRelationSourceValueRef = useRef(resolveRelationSourceValue);
  resolveRelationSourceValueRef.current = resolveRelationSourceValue;

  useEffect(() => {
    if (
      transposed ||
      !relationConnection ||
      !relationDatabase ||
      !dbType ||
      Object.keys(columnRelations).length === 0
    ) {
      setRelationLookupMaps({});
      return;
    }

    let cancelled = false;
    const currentRows = rowsForRelationLookupRef.current;
    const resolveSource = resolveRelationSourceValueRef.current;
    const lookupRows = currentRows.map((row) => {
      const next: Record<string, unknown> = { ...row };
      for (const sourceColumn of Object.keys(columnRelations)) {
        next[sourceColumn] = resolveSource(row, sourceColumn);
      }
      return next;
    });
    void fetchColumnRelationLookups(
      relationConnection,
      relationDatabase,
      dbType,
      columnRelations,
      relationTables,
      lookupRows,
    ).then((maps) => {
      if (!cancelled) {
        setRelationLookupMaps(maps);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [
    transposed,
    relationConnection,
    relationDatabase,
    dbType,
    columnRelations,
    relationTables,
    relationLookupFingerprint,
  ]);

  const previewGridColumns = useMemo(
    () => visibleColumns.filter((column) => !isRelationDisplayColumn(column) || columnRelations[relationSourceColumn(column) ?? ""]),
    [visibleColumns, columnRelations],
  );

  const previewSql = useMemo(() => {
    if (!canCopyPreviewSql || !dbType || !tableName) return "";
    const hasRelationDisplayColumns = previewGridColumns.some((column) =>
      isRelationDisplayColumn(column),
    );
    if (hasRelationDisplayColumns) {
      return buildTablePreviewSqlWithRelations({
        dbType,
        tableName,
        filter,
        sort,
        page,
        pageSize,
        columnRelations,
        relationTables,
        visibleGridColumns: previewGridColumns,
        columnMeta: columnMeta ?? undefined,
      });
    }
    const allColumnsVisible =
      previewGridColumns.length === 0 || previewGridColumns.length >= effectiveColumns.length;
    return buildTablePreviewSql({
      dbType,
      tableName,
      filter,
      sort,
      page,
      pageSize,
      selectColumns: allColumnsVisible ? undefined : previewGridColumns,
      columnMeta: columnMeta ?? undefined,
    });
  }, [
    canCopyPreviewSql,
    dbType,
    effectiveColumns.length,
    filter,
    page,
    pageSize,
    previewGridColumns,
    columnRelations,
    relationTables,
    columnMeta,
    sort,
    tableName,
  ]);

  const handleCopyPreviewSql = useCallback(async () => {
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
      // clipboard unavailable
    }
  }, [previewSql]);

  useEffect(() => {
    return () => {
      if (copySqlHintTimerRef.current != null) {
        window.clearTimeout(copySqlHintTimerRef.current);
      }
    };
  }, []);

  const handleColumnSortClick = useCallback(
    (columnId: string) => {
      if (!enableSort || !onSortChange) return;
      setPageSort(null);
      let next: SortState | null;
      if (!sort || sort.column !== columnId) {
        next = { column: columnId, direction: "asc" };
      } else if (sort.direction === "asc") {
        next = { column: columnId, direction: "desc" };
      } else {
        next = null;
      }
      onSortChange(next);
    },
    [enableSort, onSortChange, sort],
  );

  const handleHeaderClick = useCallback(
    (columnId: string) => {
      if (transposed) return;
      handleColumnSortClick(columnId);
    },
    [handleColumnSortClick, transposed],
  );

  const transposedData = useMemo(() => {
    if (!transposed) return null;
    return transposeGridData(visibleColumns, rowsWithRelationDisplay, page, pageSize, columnMeta);
  }, [transposed, visibleColumns, rowsWithRelationDisplay, page, pageSize, columnMeta]);

  const transposedDirty = useMemo(() => {
    if (!transposed) return null;
    return transposeDirtyState(rowsWithRelationDisplay, columnMeta, dirtyRowKeys, cellOverrides);
  }, [transposed, rowsWithRelationDisplay, columnMeta, dirtyRowKeys, cellOverrides]);

  const displayColumns = transposed ? transposedData!.columns : visibleColumns;
  const displayRowsBase = transposed ? transposedData!.rows : rowsWithRelationDisplay;
  const displayDirtyRowKeys = transposed ? transposedDirty!.dirtyRowKeys : dirtyRowKeys;
  const displayCellOverrides = transposed ? transposedDirty!.cellOverrides : cellOverrides;
  const displayCellOverridesRef = useRef(displayCellOverrides);
  displayCellOverridesRef.current = displayCellOverrides;
  const [pageSort, setPageSort] = useState<{ column: string; desc: boolean } | null>(null);

  const displayRows = useMemo(() => {
    if (!pageSort || transposed) return displayRowsBase;
    const col = pageSort.column;
    const sorted = [...displayRowsBase].sort((a, b) => compareCellValues(a[col], b[col]));
    return pageSort.desc ? sorted.reverse() : sorted;
  }, [displayRowsBase, pageSort, transposed]);

  useLayoutEffect(() => {
    if (loading || !hoverResetPendingRef.current) return;
    resetStuckPointerHover(wrapRef.current);
  }, [loading, displayRows]);

  const columnMetaMap = useMemo(() => {
    if (!columnMeta) return null;
    const map: Record<string, DbColumnMeta> = {};
    for (const m of columnMeta) {
      map[m.name] = m;
    }
    return map;
  }, [columnMeta]);

  const cancelCellOverlayEdit = useCallback(() => {
    setCellOverlay(null);
  }, []);

  const commitCellOverlayEdit = useCallback(() => {
    const current = cellOverlayRef.current;
    if (!current || current.mode !== "edit" || !onCellCommit) {
      setCellOverlay(null);
      return;
    }
    const rowKey = resolvePreviewRowKey(current.row, pkCols);
    const overrides = rowKey ? displayCellOverrides?.[rowKey] : undefined;
    const raw =
      overrides?.[current.column] !== undefined
        ? overrides[current.column]
        : current.row[current.column];
    const parsed = parseCellValue(current.editKind ?? "text", current.editText ?? "");
    if (!isSameCellValue(raw, parsed)) {
      onCellCommit(
        {
          rowIndex: current.rowIndex,
          column: current.column,
          row: current.row,
        },
        parsed,
      );
    }
    setCellOverlay(null);
  }, [onCellCommit, pkCols, displayCellOverrides]);

  const startCellOverlayEdit = useCallback(
    (
      target: { rowIndex: number; column: string; row: Record<string, unknown> },
      colMeta: DbColumnMeta,
      anchor: CellOverlayAnchor,
    ) => {
      if (cellOverlayRef.current?.mode === "edit") {
        commitCellOverlayEdit();
      }
      pinnedPreviewRef.current = false;
      const rowKey = resolvePreviewRowKey(target.row, pkCols);
      const overrides = rowKey ? displayCellOverrides?.[rowKey] : undefined;
      const raw =
        overrides?.[target.column] !== undefined
          ? overrides[target.column]
          : target.row[target.column];
      const kind = detectCellEditorKind(colMeta.type);
      setCellOverlay(
        buildCellEditOverlay(anchor, {
          column: target.column,
          rowIndex: target.rowIndex,
          row: target.row,
          value: raw,
          columnType: colMeta.type,
          editKind: kind,
          editText: formatInlineEditText(kind, raw),
        }),
      );
    },
    [commitCellOverlayEdit, pkCols, displayCellOverrides],
  );

  const usePanelCellEditor = Boolean(onCellEditorCollapsedChange && !cellEditorCollapsed);

  useEffect(() => {
    if (!onCellEditorCollapsedChange || cellEditorCollapsed) return;
    commitCellOverlayEdit();
  }, [cellEditorCollapsed, onCellEditorCollapsedChange, commitCellOverlayEdit]);

  const handleCellOverlayEditChange = useCallback((text: string) => {
    setCellOverlay((prev) => (prev?.mode === "edit" ? { ...prev, editText: text } : prev));
  }, []);

  const beginCellEdit = useCallback(
    (
      info: { rowIndex: number; column: string; row: Record<string, unknown> },
      opts?: { displayColIndex?: number; anchor?: CellOverlayAnchor },
    ) => {
      cellDragRef.current = null;

      let target = info;
      if (transposed) {
        const mapped = resolveTransposedDataCellContext(info.column, info.row, rows);
        if (!mapped) return;
        target = {
          rowIndex: mapped.originalRowIndex,
          column: mapped.fieldColumn,
          row: mapped.originalRow,
        };
      }

      const colMeta = columnMetaMap?.[target.column];
      if (!colMeta) return;

      const rowKey = resolvePreviewRowKey(target.row, pkCols);
      const overrides = rowKey ? displayCellOverrides?.[rowKey] : undefined;
      const raw =
        overrides?.[target.column] !== undefined
          ? overrides[target.column]
          : target.row[target.column];

      if (usePanelCellEditor) {
        onCellEditorFocusRequest?.();
        return;
      }

      const strategy = resolveCellDoubleClickEditStrategy(colMeta.type, raw);

      if (opts?.anchor) {
        if (strategy === "inline" && onCellCommit) {
          startCellOverlayEdit(target, colMeta, opts.anchor);
          return;
        }
        if (strategy === "preview") {
          openCellPreview({
            column: target.column,
            rowIndex: target.rowIndex,
            row: target.row,
            value: raw,
            columnType: colMeta.type,
            anchor: opts.anchor,
          });
          return;
        }
      }

      if (onCellEditorFocusRequest) {
        onCellEditorFocusRequest();
        return;
      }

      if (onActiveCellChange) return;

      if (!onCellEdit) return;
      onCellEdit(target);
    },
    [
      transposed,
      rows,
      columnMetaMap,
      pkCols,
      displayCellOverrides,
      onCellCommit,
      onCellEdit,
      onActiveCellChange,
      onCellEditorFocusRequest,
      usePanelCellEditor,
      startCellOverlayEdit,
      openCellPreview,
    ],
  );

  const handleCellEdit = beginCellEdit;

  const columnDefs = useMemo<ColumnDef<Record<string, unknown>>[]>(
    () => {
      const defs: ColumnDef<Record<string, unknown>>[] = displayColumns.map((col) => {
        const isFieldCol = transposed && col === TRANSPOSE_FIELD_COL;
        const isRelationDisplayCol = !transposed && isRelationDisplayColumn(col);
        const relationSource = isRelationDisplayCol ? relationSourceColumn(col) : null;
        const sourceRelation = relationSource ? columnRelations[relationSource] : undefined;
        const relatedTable = sourceRelation
          ? relationTables?.find((table) => table.name === sourceRelation.tableName)
          : undefined;
        const relationDisplayLabel = sourceRelation
          ? buildRelationDisplayColumnLabel(sourceRelation, relatedTable)
          : col;
        const rowHeaderIndex = transposed ? parseInt(col.replace("__row__", ""), 10) : -1;
        const headerMeta =
          !isFieldCol && !transposed && !isRelationDisplayCol ? columnMetaMap?.[col] : undefined;
        return {
          id: col,
          accessorFn: (row) => row[col],
          header: () => {
            if (isFieldCol) {
              return <span className="db-row-num-header">#</span>;
            }
            if (transposed && !Number.isNaN(rowHeaderIndex)) {
              return (
                <span className="db-row-num-header">
                  {pageRef.current * pageSizeRef.current + rowHeaderIndex + 1}
                </span>
              );
            }
            return (
              <ColumnHeaderLabel
                label={isRelationDisplayCol ? relationDisplayLabel : col}
                meta={headerMeta}
                t={t}
              />
            );
          },
          cell: ({ getValue, row, column }) => {
            const value = getValue();
            if (isFieldCol) {
              const fieldName = String(value ?? "");
              return (
                <TableDataGridTransposeFieldCell
                  fieldName={fieldName}
                  fieldMeta={columnMetaMap?.[fieldName]}
                  canFilter={canFilter}
                  filterColumnNames={filterColumnNames}
                  enableSort={enableSort}
                  sortColumn={sort?.column ?? null}
                  sortDirection={sort?.direction ?? null}
                  onSortClick={handleColumnSortClick}
                  onOpenFilter={openFilterPopover}
                  t={t}
                />
              );
            }
            const isRowNumCol = column.id === ROW_NUM_COL_ID;
            if (isRowNumCol) {
              return (
                <span className="db-row-num-cell">
                  {pageRef.current * pageSizeRef.current + row.index + 1}
                </span>
              );
            }
            const colMetaForCell = transposed
              ? columnMetaMap?.[String(row.original[TRANSPOSE_FIELD_COL] ?? "")]
              : isRelationDisplayCol
                ? undefined
                : columnMetaMap?.[column.id];
            const rowKey = transposed
              ? String(row.original[TRANSPOSE_FIELD_COL] ?? "")
              : resolvePreviewRowKey(row.original, pkCols);
            const overrideForRow = rowKey
              ? displayCellOverridesRef.current?.[rowKey]
              : undefined;
            const resolvedValue =
              overrideForRow?.[column.id] !== undefined
                ? overrideForRow[column.id]
                : value;
            return (
              <TableDataGridCellContent
                value={resolvedValue}
                row={row.original}
                columnId={column.id}
                colMeta={colMetaForCell}
                overrideForRow={overrideForRow}
                pkCount={pkCount}
                autoIncrementPlaceholder={autoIncrementPlaceholder}
                t={t}
              />
            );
          },
          minSize: isFieldCol ? 80 : COLUMN_MIN_WIDTH,
          size: isFieldCol ? 108 : isRelationDisplayCol ? 140 : defaultDataColumnWidth(headerMeta?.type),
        };
      });
      if (!transposed) {
        defs.unshift({
          id: ROW_NUM_COL_ID,
          accessorFn: () => undefined,
          header: () => <span className="db-row-num-header">#</span>,
          cell: ({ row: r }) => (
            <span className="db-row-num-cell">
              {pageRef.current * pageSizeRef.current + r.index + 1}
            </span>
          ),
          minSize: 28,
          size: 36,
          enableResizing: false,
          enableSorting: false,
        });
      }
      return defs;
    },
    [displayColumns, transposed, columnMetaMap, columnRelations, relationTables, t, canFilter, filterColumnNames, openFilterPopover, enableSort, sort, handleColumnSortClick, pkCols, pkCount, autoIncrementPlaceholder],
  );

  const table = useReactTable({
    data: displayRows,
    columns: columnDefs,
    state: { columnSizing },
    onColumnSizingChange: setColumnSizing,
    columnResizeMode: "onEnd",
    enableColumnResizing: true,
    getCoreRowModel: getCoreRowModel(),
  });

  const beginRowResize = useCallback(
    (rowIndex: number, clientY: number) => {
      const wrap = wrapRef.current;
      const measured =
        rowHeights[rowIndex] ??
        wrap
          ?.querySelector<HTMLTableRowElement>(`tr[data-row-index="${rowIndex}"]`)
          ?.getBoundingClientRect().height ??
        DEFAULT_ROW_HEIGHT;
      dragRef.current = {
        rowIndex,
        startY: clientY,
        startHeight: measured,
        lastHeight: measured,
      };
      wrap?.classList.add("db-data-table-wrap--resizing");
      wrap
        ?.querySelector(`tr[data-row-index="${rowIndex}"]`)
        ?.classList.add("db-data-table-row--resizing");
    },
    [rowHeights],
  );

  useEffect(() => {
    const scrollWrapWhileDragging = (wrap: HTMLElement, clientX: number, clientY: number) => {
      const rect = wrap.getBoundingClientRect();
      const edge = 32;
      let dx = 0;
      let dy = 0;
      if (clientY < rect.top + edge) {
        dy = -Math.ceil((edge - (clientY - rect.top)) * 0.7);
      } else if (clientY > rect.bottom - edge) {
        dy = Math.ceil((edge - (rect.bottom - clientY)) * 0.7);
      }
      if (clientX < rect.left + edge) {
        dx = -Math.ceil((edge - (clientX - rect.left)) * 0.7);
      } else if (clientX > rect.right - edge) {
        dx = Math.ceil((edge - (rect.right - clientX)) * 0.7);
      }
      if (dx !== 0 || dy !== 0) {
        wrap.scrollBy(dx, dy);
      }
    };

    const flushDragSelectionPaint = () => {
      const wrap = wrapRef.current;
      const pending = pendingDragRangeRef.current;
      if (!wrap || !pending) return;
      cellRangeRef.current = pending;
      paintDragSelection(wrap, pending);
    };

    const onMouseMove = (event: MouseEvent) => {
      const wrap = wrapRef.current;
      if (!wrap) return;

      const rowDrag = rowDragRef.current;
      if (rowDrag?.active) {
        scrollWrapWhileDragging(wrap, event.clientX, event.clientY);
        const el = document.elementFromPoint(event.clientX, event.clientY);
        const tr = el?.closest("tr");
        if (tr instanceof HTMLTableRowElement) {
          const rowIndex = Number(tr.dataset.rowIndex);
          if (!Number.isNaN(rowIndex)) {
            pendingDragRangeRef.current = {
              start: { row: rowDrag.startRow, col: 0 },
              end: { row: rowIndex, col: rowDrag.maxCol },
            };
          }
        }
        if (dragSelectionRafRef.current == null) {
          dragSelectionRafRef.current = requestAnimationFrame(() => {
            dragSelectionRafRef.current = null;
            flushDragSelectionPaint();
          });
        }
        return;
      }

      const cellDrag = cellDragRef.current;
      if (cellDrag?.active) {
        scrollWrapWhileDragging(wrap, event.clientX, event.clientY);
        const el = document.elementFromPoint(event.clientX, event.clientY);
        const td = el?.closest("td");
        if (td) {
          const tr = td.closest("tr");
          if (tr) {
            const rowIndex = Number((tr as HTMLElement).dataset.rowIndex);
            const colIndex = Number((td as HTMLElement).dataset.colIndex);
            if (!Number.isNaN(rowIndex) && !Number.isNaN(colIndex)) {
              pendingDragRangeRef.current = {
                start: cellDrag.start,
                end: { row: rowIndex, col: colIndex },
              };
            }
          }
        }
        if (dragSelectionRafRef.current == null) {
          dragSelectionRafRef.current = requestAnimationFrame(() => {
            dragSelectionRafRef.current = null;
            flushDragSelectionPaint();
          });
        }
        return;
      }

      const drag = dragRef.current;
      if (drag) {
        const next = Math.max(
          MIN_ROW_HEIGHT,
          drag.startHeight + (event.clientY - drag.startY),
        );
        if (next === drag.lastHeight) return;
        drag.lastHeight = next;
        const row = wrap.querySelector<HTMLElement>(`tr[data-row-index="${drag.rowIndex}"]`);
        if (row) {
          row.style.height = `${next}px`;
          row.classList.add("db-data-table-row--custom-h");
        }
        return;
      }

      const col = colResizeRef.current;
      if (col) {
        const diff = event.clientX - col.startX;
        const newWidth = Math.max(COLUMN_MIN_WIDTH, col.startWidth + diff);
        if (newWidth === col.lastWidth) return;
        col.lastWidth = newWidth;
        applyColumnWidthDom(wrap, col.columnId, newWidth);
      }
    };

    const onScrollDuringDrag = () => {
      if (!cellDragRef.current?.active && !rowDragRef.current?.active) return;
      if (dragSelectionRafRef.current == null) {
        dragSelectionRafRef.current = requestAnimationFrame(() => {
          dragSelectionRafRef.current = null;
          flushDragSelectionPaint();
        });
      }
    };

    const endResize = () => {
      const wrap = wrapRef.current;
      const wasCellDrag = Boolean(cellDragRef.current?.active);
      const wasRowDrag = Boolean(rowDragRef.current?.active);
      const pendingDragRange = pendingDragRangeRef.current;

      if (cellDragRef.current) {
        cellDragRef.current = null;
      }
      if (rowDragRef.current) {
        rowDragRef.current = null;
      }
      pendingDragRangeRef.current = null;
      if (dragSelectionRafRef.current != null) {
        cancelAnimationFrame(dragSelectionRafRef.current);
        dragSelectionRafRef.current = null;
      }
      if (wrap) {
        clearDragSelectionPaint(wrap);
        wrap.classList.remove("db-data-table-wrap--cell-dragging");
      }

      // 拖选过程只刷 DOM；抬起时一次性提交 React 选区
      if ((wasCellDrag || wasRowDrag) && pendingDragRange) {
        cellRangeRef.current = pendingDragRange;
        setCellRange(pendingDragRange);
      }

      const drag = dragRef.current;
      if (drag && wrap) {
        setRowHeights((prev) => {
          if (prev[drag.rowIndex] === drag.lastHeight) return prev;
          return { ...prev, [drag.rowIndex]: drag.lastHeight };
        });
        wrap.querySelector(`tr[data-row-index="${drag.rowIndex}"]`)?.classList.remove("db-data-table-row--resizing");
      }

      const col = colResizeRef.current;
      if (col) {
        setColumnSizing((prev) => {
          if (prev[col.columnId] === col.lastWidth) return prev;
          return { ...prev, [col.columnId]: col.lastWidth };
        });
        wrap?.querySelector(`th[data-col-id="${CSS.escape(col.columnId)}"]`)?.classList.remove("db-data-table-th-resizing");
      }

      dragRef.current = null;
      colResizeRef.current = null;
      wrap?.classList.remove("db-data-table-wrap--resizing", "db-data-table-wrap--col-resizing");
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || reserveSelectionOnEscapeRef.current) return;
      if (cellPreviewOpenRef.current) return;
      if (cellDragRef.current?.active || rowDragRef.current?.active) {
        cellDragRef.current = null;
        rowDragRef.current = null;
        pendingDragRangeRef.current = null;
        if (dragSelectionRafRef.current != null) {
          cancelAnimationFrame(dragSelectionRafRef.current);
          dragSelectionRafRef.current = null;
        }
        const wrap = wrapRef.current;
        if (wrap) {
          clearDragSelectionPaint(wrap);
          wrap.classList.remove("db-data-table-wrap--cell-dragging");
        }
      }
      if (cellRangeRef.current || selectedRowsRef.current.size > 0) {
        clearGridSelection();
      }
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", endResize);
    window.addEventListener("keydown", onKeyDown);
    const wrap = wrapRef.current;
    wrap?.addEventListener("scroll", onScrollDuringDrag, { passive: true });
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", endResize);
      window.removeEventListener("keydown", onKeyDown);
      wrap?.removeEventListener("scroll", onScrollDuringDrag);
    };
  }, [clearGridSelection]);

  const totalTableWidth = table.getTotalSize();
  const leafColumns = table.getAllLeafColumns();
  const lastColumnId = leafColumns[leafColumns.length - 1]?.id ?? "";
  const fillDelta =
    containerWidth > 0 ? Math.max(0, containerWidth - totalTableWidth) : 0;

  const resolveColumnWidth = useCallback(
    (columnId: string, baseSize: number) =>
      fillDelta > 0 && columnId === lastColumnId ? baseSize + fillDelta : baseSize,
    [fillDelta, lastColumnId],
  );

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const syncWidth = () => setContainerWidth(wrap.clientWidth);
    syncWidth();
    const ro = new ResizeObserver(syncWidth);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    for (const column of table.getAllLeafColumns()) {
      applyColumnWidthDom(wrap, column.id, resolveColumnWidth(column.id, column.getSize()));
    }
  }, [columnSizing, displayColumns, totalTableWidth, containerWidth, fillDelta, lastColumnId, resolveColumnWidth]);

  const allColumnsHidden = sidebarColumns.length > 0 && visibleColumns.length === 0;
  const tableRows = table.getRowModel().rows;
  const leafColumnCount = table.getAllLeafColumns().length;

  const selectedRowIndices = useMemo(
    () =>
      transposed
        ? []
        : collectSelectedRowIndices(cellRange, selectedRows, leafColumnCount),
    [transposed, cellRange, selectedRows, leafColumnCount],
  );
  const hasSelectedRows = selectedRowIndices.length > 0;

  const handleDeleteSelectedRows = useCallback(() => {
    if (!onDeleteSelectedRows || selectedRowIndices.length === 0) return;
    const payload = selectedRowIndices
      .map((index) => {
        const tableRow = tableRows[index];
        if (!tableRow) return null;
        return { rowIndex: tableRow.index, row: tableRow.original };
      })
      .filter((item): item is { rowIndex: number; row: Record<string, unknown> } => item != null);
    if (payload.length === 0) return;
    onDeleteSelectedRows(payload);
    setCellRange(null);
    setSelectedRows(new Set());
    rowAnchorRef.current = null;
    cellAnchorRef.current = null;
  }, [onDeleteSelectedRows, selectedRowIndices, tableRows]);

  useEffect(() => {
    onSelectedRowCountChange?.(selectedRowIndices.length);
  }, [selectedRowIndices.length, onSelectedRowCountChange]);

  useEffect(() => {
    if (!gridActionsRef) return;
    gridActionsRef.current = {
      deleteSelectedRows: handleDeleteSelectedRows,
      toggleColSidebar: () => {
        setColSidebarCollapsed((prev) => !prev);
      },
      copyPreviewSql: () => {
        void handleCopyPreviewSql();
      },
      isColSidebarCollapsed: () => colSidebarCollapsed,
      hasInlineEdit: () => cellOverlayRef.current?.mode === "edit",
      cancelInlineEdit: () => cancelCellOverlayEdit(),
      hasSelection: () =>
        Boolean(cellRangeRef.current || selectedRowsRef.current.size > 0),
      clearSelection: () => clearGridSelection(),
    };
    return () => {
      if (gridActionsRef.current) {
        gridActionsRef.current = null;
      }
    };
  }, [
    gridActionsRef,
    handleDeleteSelectedRows,
    handleCopyPreviewSql,
    colSidebarCollapsed,
    cancelCellOverlayEdit,
    clearGridSelection,
  ]);

  useEffect(() => {
    if (!onActiveCellChange) return;
    const activeCell = resolveSingleSelectedCell(cellRange, leafColumns, tableRows, {
      transposed,
      rows,
    });
    const nextKey = selectionTargetKey(activeCell);
    if (nextKey === activeCellNotifyKeyRef.current) return;
    activeCellNotifyKeyRef.current = nextKey;
    onActiveCellChange(activeCell);
  }, [cellRange, leafColumns, tableRows, transposed, rows, onActiveCellChange]);

  useEffect(() => {
    if (!onSelectedCellsChange) return;
    const targets = collectSelectedCellTargets(
      cellRange,
      selectedRows,
      leafColumns,
      tableRows,
      leafColumnCount,
      { transposed, rows },
    );
    const nextKey = selectionTargetsKey(targets);
    if (nextKey === selectedCellsNotifyKeyRef.current) return;
    selectedCellsNotifyKeyRef.current = nextKey;
    onSelectedCellsChange(targets);
  }, [
    cellRange,
    selectedRows,
    leafColumns,
    tableRows,
    leafColumnCount,
    transposed,
    rows,
    onSelectedCellsChange,
  ]);

  useEffect(() => {
    const edit = cellOverlayRef.current;
    if (!edit || edit.mode !== "edit" || transposed) return;
    const selected = resolveSingleSelectedCell(cellRange, leafColumns, tableRows, {
      transposed,
      rows,
    });
    if (
      !selected ||
      selected.rowIndex !== edit.rowIndex ||
      selected.column !== edit.column
    ) {
      commitCellOverlayEdit();
    }
  }, [
    cellRange,
    leafColumns,
    tableRows,
    transposed,
    rows,
    commitCellOverlayEdit,
  ]);

  useEffect(() => {
    const onGridClipboardKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.shiftKey || event.altKey) return;
      if (isEditableTextTarget(event.target)) return;
      if (document.activeElement instanceof HTMLElement) {
        if (isEditableTextTarget(document.activeElement)) return;
        if (document.activeElement.closest(".sql-codemirror-editor")) return;
      }

      const key = event.key.toLowerCase();
      const range = cellRangeRef.current;
      const extraRows = selectedRowsRef.current;

      if (key === "c") {
        const format = clipboardFormatRef.current;
        let text = "";
        if (range) {
          text = buildCellRangeClipboardText(range, leafColumns, tableRows, {
            pkCols,
            transposed,
            displayCellOverrides,
            format,
          });
        } else if (extraRows.size > 0) {
          text = buildSelectedRowsClipboardText(extraRows, leafColumns, tableRows, {
            pkCols,
            transposed,
            displayCellOverrides,
            format,
          });
        }
        if (!text) return;

        event.preventDefault();
        event.stopPropagation();
        void navigator.clipboard.writeText(text).then(() => {
          showToast(t("common.copied"));
        }).catch(() => {
          /* clipboard unavailable */
        });

        if (!transposed) {
          let singleRowIndex: number | null = null;
          if (range && isFullRowSelection(range, leafColumnCount)) {
            singleRowIndex = normalizeRange(range).minRow;
          } else if (extraRows.size === 1) {
            singleRowIndex = [...extraRows][0] ?? null;
          }
          if (singleRowIndex != null) {
            const rowValues = extractRowValuesFromIndex(
              singleRowIndex,
              tableRows,
              effectiveColumns,
              pkCols,
              displayCellOverrides,
            );
            copiedRowRef.current = rowValues;
          } else {
            copiedRowRef.current = null;
          }
        } else {
          copiedRowRef.current = null;
        }
        return;
      }

      if (key === "v") {
        if (transposed) return;

        const pasteBounds = resolvePasteBounds(range, extraRows, leafColumnCount, tableRows.length);
        if (pasteBounds && onCellCommit) {
          event.preventDefault();
          event.stopPropagation();
          void navigator.clipboard.readText().then((text) => {
            const matrix = parseClipboardMatrix(text, clipboardFormatRef.current);
            if (matrix.length === 0) {
              showToast(t("database.cellEditor.pasteCellsUnavailable"));
              return;
            }

            let applied = 0;
            for (let r = 0; r < matrix.length; r += 1) {
              const csvRow = matrix[r] ?? [];
              for (let c = 0; c < csvRow.length; c += 1) {
                const targetRow = pasteBounds.startRow + r;
                const targetCol = pasteBounds.startCol + c;
                if (targetRow >= tableRows.length || targetCol >= leafColumnCount) {
                  continue;
                }
                const target = resolveSingleSelectedCell(
                  {
                    start: { row: targetRow, col: targetCol },
                    end: { row: targetRow, col: targetCol },
                  },
                  leafColumns,
                  tableRows,
                  { transposed, rows },
                );
                if (!target) continue;
                const colMeta = columnMetaMap?.[target.column];
                const kind = detectCellEditorKind(colMeta?.type ?? "text");
                const parsed = parseCellValue(kind, csvRow[c] ?? "");
                onCellCommit(
                  {
                    rowIndex: target.rowIndex,
                    column: target.column,
                    row: target.row,
                  },
                  parsed,
                );
                applied += 1;
              }
            }

            if (applied > 0) {
              showToast(t("database.cellEditor.pasteCellsDone", { count: applied }));
            } else {
              showToast(t("database.cellEditor.pasteCellsUnavailable"));
            }
          }).catch(() => {
            showToast(t("database.cellEditor.pasteCellsUnavailable"));
          });
          return;
        }

        if (!onRowPaste) {
          showToast(t("database.cellEditor.pasteCellsUnavailable"));
          return;
        }
        const rowValues = copiedRowRef.current;
        if (!rowValues) {
          showToast(t("database.rowEditor.pasteRowUnavailable"));
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        onRowPaste({ values: { ...rowValues } });
        showToast(t("database.rowEditor.pasteRowDone"));
        return;
      }
    };

    window.addEventListener("keydown", onGridClipboardKeyDown, true);
    return () => window.removeEventListener("keydown", onGridClipboardKeyDown, true);
  }, [
    leafColumns,
    tableRows,
    pkCols,
    transposed,
    displayCellOverrides,
    leafColumnCount,
    effectiveColumns,
    columnMetaMap,
    onCellCommit,
    onRowPaste,
    rows,
    t,
  ]);

  const getRowHeight = useCallback(
    (index: number) => {
      const row = tableRows[index];
      if (!row) return DEFAULT_ROW_HEIGHT;
      return rowHeights[row.index] ?? DEFAULT_ROW_HEIGHT;
    },
    [tableRows, rowHeights],
  );

  const useRowVirtualization = tableRows.length > ROW_VIRTUALIZE_THRESHOLD;

  const scrollAndHighlightColumn = useCallback(
    (columnName: string) => {
      const wrap = wrapRef.current;
      if (!wrap) {
        return;
      }

      setNavigatedColumnId(columnName);

      if (transposed) {
        const rowIdx = displayRows.findIndex((row) => row[TRANSPOSE_FIELD_COL] === columnName);
        if (rowIdx < 0) {
          return;
        }
        if (useRowVirtualization) {
          virtualBodyRef.current?.scrollToIndex(rowIdx, { align: "center", behavior: "smooth" });
        } else {
          const tr = wrap.querySelector<HTMLElement>(`tr[data-row-index="${rowIdx}"]`);
          if (tr) {
            scrollElementToCenter(wrap, tr);
          }
        }
        const maxCol = leafColumnCount - 1;
        if (maxCol >= 0) {
          setSelectedRows(new Set());
          rowAnchorRef.current = rowIdx;
          cellAnchorRef.current = { row: rowIdx, col: 0 };
          setCellRange({
            start: { row: rowIdx, col: 0 },
            end: { row: rowIdx, col: maxCol },
          });
        }
        return;
      }

      const colIdx = leafColumns.findIndex((column) => column.id === columnName);
      if (colIdx < 0) {
        return;
      }

      const th = wrap.querySelector<HTMLElement>(`th[data-col-id="${CSS.escape(columnName)}"]`);
      if (th) {
        scrollElementToCenter(wrap, th);
      }

      const maxRow = tableRows.length - 1;
      if (maxRow >= 0) {
        setSelectedRows(new Set());
        rowAnchorRef.current = 0;
        cellAnchorRef.current = { row: 0, col: colIdx };
        setCellRange({
          start: { row: 0, col: colIdx },
          end: { row: maxRow, col: colIdx },
        });
      }
    },
    [
      transposed,
      displayRows,
      leafColumns,
      leafColumnCount,
      tableRows.length,
      useRowVirtualization,
    ],
  );

  const handleColumnNavigate = useCallback(
    (columnName: string) => {
      if (!isSidebarColumnVisible(columnName)) {
        setHiddenColumns((prev) => {
          const next = new Set(prev);
          next.delete(columnName);
          if (isRelationDisplayColumn(columnName)) {
            const sourceColumn = relationSourceColumn(columnName);
            if (sourceColumn) {
              next.delete(sourceColumn);
            }
          }
          return next;
        });
        pendingColumnFocusRef.current = columnName;
        return;
      }
      scrollAndHighlightColumn(columnName);
    },
    [isSidebarColumnVisible, scrollAndHighlightColumn, setHiddenColumns],
  );

  useLayoutEffect(() => {
    const pending = pendingColumnFocusRef.current;
    if (!pending || !isSidebarColumnVisible(pending)) {
      return;
    }
    pendingColumnFocusRef.current = null;
    scrollAndHighlightColumn(pending);
  }, [visibleColumns, hiddenColumns, isSidebarColumnVisible, scrollAndHighlightColumn]);

  const handleSelectAll = useCallback(() => {
    const maxRow = tableRows.length - 1;
    if (maxRow < 0) return;
    const maxCol = leafColumnCount - 1;
    if (maxCol < 0) return;
    setSelectedRows(new Set());
    rowAnchorRef.current = 0;
    cellAnchorRef.current = { row: 0, col: 0 };
    setCellRange({
      start: { row: 0, col: 0 },
      end: { row: maxRow, col: maxCol },
    });
  }, [tableRows.length, leafColumnCount]);

  const handleColumnSelect = useCallback(
    (colId: string) => {
      const colIdx = leafColumns.findIndex((c) => c.id === colId);
      if (colIdx < 0) return;
      const maxRow = tableRows.length - 1;
      if (maxRow < 0) return;
      setSelectedRows(new Set());
      rowAnchorRef.current = 0;
      cellAnchorRef.current = { row: 0, col: colIdx };
      setCellRange({
        start: { row: 0, col: colIdx },
        end: { row: maxRow, col: colIdx },
      });
    },
    [leafColumns, tableRows.length],
  );

  /** 转置模式下双击顶部列头（__row__N，显示行号）：选中该列并弹出记录面板 */
  const handleTransposeRowHeaderDoubleClick = useCallback(
    (colId: string, event: ReactMouseEvent) => {
      if (!transposed || !colId.startsWith("__row__")) return;
      // 避免与列宽重置（resize handle 的 onDoubleClick）冲突
      if (event.target instanceof Element && event.target.closest(".db-col-resize-handle")) return;
      handleColumnSelect(colId);
      onOpenRowDetail?.();
      onRowBandSelect?.();
    },
    [transposed, handleColumnSelect, onOpenRowDetail, onRowBandSelect],
  );

  const handleRowBandSelect = useCallback(
    (rowIndex: number, event: ReactMouseEvent) => {
      const maxCol = leafColumnCount - 1;
      if (maxCol < 0) return;

      const mod = event.ctrlKey || event.metaKey;

      if (event.shiftKey && rowAnchorRef.current != null) {
        const anchor = rowAnchorRef.current;
        const minRow = Math.min(anchor, rowIndex);
        const maxRow = Math.max(anchor, rowIndex);
        setSelectedRows(new Set());
        cellDragRef.current = null;
        rowDragRef.current = null;
        setCellRange({
          start: { row: minRow, col: 0 },
          end: { row: maxRow, col: maxCol },
        });
        onRowBandSelect?.();
        return;
      }

      if (mod) {
        const fromRange =
          cellRangeRef.current && isFullWidthRowRange(cellRangeRef.current, leafColumnCount)
            ? rowsInFullRowRange(cellRangeRef.current, leafColumnCount)
            : new Set<number>();
        const next = new Set([...selectedRowsRef.current, ...fromRange]);
        if (next.has(rowIndex)) {
          next.delete(rowIndex);
        } else {
          next.add(rowIndex);
        }
        setSelectedRows(next);
        setCellRange(null);
        cellDragRef.current = null;
        rowDragRef.current = null;
        rowAnchorRef.current = rowIndex;
        cellAnchorRef.current = null;
        onRowBandSelect?.();
        return;
      }

      // 普通按下：开始行拖选（上下拖动多选整行）
      setSelectedRows(new Set());
      cellDragRef.current = null;
      rowAnchorRef.current = rowIndex;
      cellAnchorRef.current = { row: rowIndex, col: 0 };
      const range = {
        start: { row: rowIndex, col: 0 },
        end: { row: rowIndex, col: maxCol },
      };
      rowDragRef.current = { active: true, startRow: rowIndex, maxCol };
      pendingDragRangeRef.current = range;
      wrapRef.current?.classList.add("db-data-table-wrap--cell-dragging");
      setCellRange(range);
      onRowBandSelect?.();
    },
    [leafColumnCount, onRowBandSelect],
  );

  const handleRowBandDoubleClick = useCallback(
    (rowIndex: number) => {
      const maxCol = leafColumnCount - 1;
      if (maxCol < 0) return;
      setSelectedRows(new Set());
      cellDragRef.current = null;
      rowDragRef.current = null;
      rowAnchorRef.current = rowIndex;
      cellAnchorRef.current = { row: rowIndex, col: 0 };
      setCellRange({
        start: { row: rowIndex, col: 0 },
        end: { row: rowIndex, col: maxCol },
      });
      onOpenRowDetail?.();
      onRowBandSelect?.();
    },
    [leafColumnCount, onOpenRowDetail, onRowBandSelect],
  );

  const columnSizedIds = useMemo(
    () => new Set(Object.keys(columnSizing)),
    [columnSizing],
  );

  const virtualizableColumnIndices = useMemo(
    () => buildVirtualizableColumnIndices(leafColumns, transposed),
    [leafColumns, transposed],
  );
  const useColumnVirtualization = shouldVirtualizeGridColumns(leafColumns.length);

  const columnVirtualizer = useVirtualizer({
    count: useColumnVirtualization ? virtualizableColumnIndices.length : 0,
    getScrollElement: () => (useColumnVirtualization ? wrapRef.current : null),
    estimateSize: (index) => {
      const colIndex = virtualizableColumnIndices[index] ?? 0;
      const column = leafColumns[colIndex];
      if (!column) {
        return DEFAULT_DATA_COLUMN_WIDTH;
      }
      return resolveColumnWidth(column.id, column.getSize());
    },
    horizontal: true,
    overscan: COLUMN_VIRTUALIZE_OVERSCAN,
    useFlushSync: false,
  });

  const columnVirtualItems = useColumnVirtualization
    ? columnVirtualizer.getVirtualItems()
    : [];

  useLayoutEffect(() => {
    if (!useColumnVirtualization) {
      return;
    }
    columnVirtualizer.measure();
  }, [useColumnVirtualization, columnSizing, totalTableWidth, fillDelta, columnVirtualizer]);

  const columnLayout = useMemo(
    () =>
      buildColumnVirtualizationLayout(
        leafColumns,
        transposed,
        columnVirtualItems,
        virtualizableColumnIndices,
        useColumnVirtualization ? columnVirtualizer.getTotalSize() : 0,
      ),
    [
      leafColumns,
      transposed,
      columnVirtualItems,
      virtualizableColumnIndices,
      useColumnVirtualization,
      columnVirtualizer,
    ],
  );

  const gridBodyStaticConfig = useMemo((): GridBodyStaticConfig => {
    return {
      transposed,
      columnMetaMap,
      canFilter,
      filterColumnNames,
      enableSort,
      sortColumn: sort?.column ?? null,
      sortDirection: sort?.direction ?? null,
      hasCellEdit: Boolean(onCellEdit || onCellCommit),
      enableValuePanelAffordance: Boolean(onCellEditorFocusRequest),
      valuePanelAffordanceTitle: t("database.cellEditor.openValuePanel"),
      lastColumnId,
      fillDelta,
      leafColumnCount,
      columnSizedIds,
      columnLayout,
      relationHighlightColumnIds,
    };
  }, [
    transposed,
    columnMetaMap,
    canFilter,
    filterColumnNames,
    enableSort,
    sort,
    onCellEdit,
    onCellCommit,
    onCellEditorFocusRequest,
    t,
    lastColumnId,
    fillDelta,
    leafColumnCount,
    columnSizedIds,
    columnLayout,
    relationHighlightColumnIds,
  ]);

  const resolveBodyCellContext = useCallback(
    (rowIndex: number, colIndex: number): GridBodyCellInteractionContext | null => {
      const tableRow = tableRows[rowIndex];
      const column = leafColumns[colIndex];
      if (!tableRow || !column) return null;
      const columnId = column.id;
      const isFieldCol = transposed && columnId === TRANSPOSE_FIELD_COL;
      const transposedFieldName = transposed
        ? String(tableRow.original[TRANSPOSE_FIELD_COL] ?? "")
        : "";
      const isRowNum = columnId === ROW_NUM_COL_ID;
      const colMeta =
        isRowNum || isFieldCol
          ? undefined
          : transposed
            ? columnMetaMap?.[transposedFieldName]
            : columnMetaMap?.[columnId];
      const rowKey = transposed
        ? transposedFieldName
        : resolvePreviewRowKey(tableRow.original, pkCols);
      const overrideForRow = rowKey ? displayCellOverrides?.[rowKey] : undefined;
      const overrideValue =
        isRowNum || isFieldCol ? undefined : overrideForRow?.[columnId];
      const rawValue =
        isRowNum || isFieldCol
          ? undefined
          : overrideValue !== undefined
            ? overrideValue
            : tableRow.original[columnId];
      const canEdit =
        !isRowNum &&
        !isFieldCol &&
        Boolean(onCellEdit || onCellCommit || onActiveCellChange) &&
        Boolean(colMeta);
      return {
        rowIndex: tableRow.index,
        colIndex,
        columnId,
        row: tableRow.original,
        isFieldCol,
        fieldName: transposedFieldName,
        rawValue,
        canEdit,
        columnType: colMeta?.type,
      };
    },
    [
      tableRows,
      leafColumns,
      transposed,
      columnMetaMap,
      pkCols,
      displayCellOverrides,
      onCellEdit,
      onCellCommit,
      onActiveCellChange,
    ],
  );

  const handleDataCellMouseDown = useCallback(
    (ctx: GridBodyCellInteractionContext, event: ReactMouseEvent) => {
      if (event.button !== 0) return;
      pinnedPreviewRef.current = false;
      if (event.shiftKey && cellAnchorRef.current) {
        event.preventDefault();
        event.stopPropagation();
        setSelectedRows(new Set());
        setCellRange({
          start: cellAnchorRef.current,
          end: { row: ctx.rowIndex, col: ctx.colIndex },
        });
        rowAnchorRef.current = ctx.rowIndex;
        return;
      }
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        setSelectedRows(new Set());
        const anchor = { row: ctx.rowIndex, col: ctx.colIndex };
        cellAnchorRef.current = anchor;
        rowAnchorRef.current = ctx.rowIndex;
        setCellRange({ start: anchor, end: anchor });
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setSelectedRows(new Set());
      rowDragRef.current = null;
      cellDragRef.current = { active: true, start: { row: ctx.rowIndex, col: ctx.colIndex } };
      cellAnchorRef.current = { row: ctx.rowIndex, col: ctx.colIndex };
      rowAnchorRef.current = ctx.rowIndex;
      const anchorRange = {
        start: { row: ctx.rowIndex, col: ctx.colIndex },
        end: { row: ctx.rowIndex, col: ctx.colIndex },
      };
      pendingDragRangeRef.current = anchorRange;
      wrapRef.current?.classList.add("db-data-table-wrap--cell-dragging");
      setCellRange(anchorRange);
    },
    [transposed, rows],
  );

  useEffect(() => {
    if (transposed) setPageSort(null);
  }, [transposed]);

  const writeClipboardText = useCallback(
    async (text: string) => {
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        showToast(t("database.results.contextMenu.copied"));
      } catch {
        /* clipboard unavailable */
      }
    },
    [t],
  );

  const handleDataCellDoubleClick = useCallback(
    (ctx: GridBodyCellInteractionContext, anchor: CellOverlayAnchor) => {
      handleCellEdit(
        { rowIndex: ctx.rowIndex, column: ctx.columnId, row: ctx.row },
        { anchor },
      );
    },
    [handleCellEdit],
  );

  const handleDataCellContextMenu = useCallback(
    (ctx: GridBodyCellInteractionContext, event: ReactMouseEvent) => {
      const leafCount = table.getAllLeafColumns().length;
      const alreadySelected = isCellSelected(
        ctx.rowIndex,
        ctx.colIndex,
        cellRangeRef.current,
        selectedRowsRef.current,
        leafCount,
      );
      if (!alreadySelected) {
        const anchor = { row: ctx.rowIndex, col: ctx.colIndex };
        cellAnchorRef.current = anchor;
        rowAnchorRef.current = ctx.rowIndex;
        setSelectedRows(new Set());
        setCellRange({ start: anchor, end: anchor });
      }

      let previewColumn = ctx.columnId;
      let menuRowIndex = ctx.rowIndex;
      let menuRow = ctx.row;
      let menuValue = ctx.rawValue;
      let rowActionsEnabled = true;
      if (transposed) {
        if (ctx.isFieldCol) {
          previewColumn = ctx.fieldName;
          menuValue = ctx.fieldName;
          rowActionsEnabled = false;
        } else {
          const mapped = resolveTransposedDataCellContext(ctx.columnId, ctx.row, rows);
          if (mapped) {
            previewColumn = mapped.fieldColumn;
            menuRowIndex = mapped.originalRowIndex;
            menuRow = mapped.originalRow;
          }
        }
      } else if (ctx.columnId === ROW_NUM_COL_ID) {
        previewColumn = effectiveColumns[0] ?? ctx.columnId;
        menuValue = ctx.rowIndex;
      }
      cellMenuOpenRef.current({
        x: event.clientX,
        y: event.clientY,
        rowIndex: menuRowIndex,
        colIndex: ctx.colIndex,
        column: previewColumn,
        row: menuRow,
        value: menuValue,
        columnType: columnMetaMap?.[previewColumn]?.type,
        rowActionsEnabled,
      });
    },
    [transposed, rows, columnMetaMap, table, effectiveColumns],
  );

  const buildCellContextMenuItems = useCallback(
    (menu: TableDataGridCellMenuState) => {
      const leafCols = table.getAllLeafColumns();
      const leafCount = leafCols.length;
      const currentRange = cellRangeRef.current;
      const currentExtraRows = selectedRowsRef.current;
      const selectedIndices = collectSelectedRowIndices(currentRange, currentExtraRows, leafCount);
      let targetRowIndices: number[];
      if (!transposed && selectedIndices.includes(menu.rowIndex)) {
        targetRowIndices = selectedIndices;
      } else if (!transposed && currentRange) {
        const n = normalizeRange(currentRange);
        if (menu.rowIndex >= n.minRow && menu.rowIndex <= n.maxRow && n.maxRow > n.minRow) {
          targetRowIndices = Array.from({ length: n.maxRow - n.minRow + 1 }, (_, i) => n.minRow + i);
        } else {
          targetRowIndices = [menu.rowIndex];
        }
      } else {
        targetRowIndices = [menu.rowIndex];
      }
      const rowCount = Math.max(1, targetRowIndices.length);
      const canSortColumn =
        Boolean(menu.column) &&
        menu.column !== ROW_NUM_COL_ID &&
        !isRelationDisplayColumn(menu.column) &&
        menu.rowActionsEnabled !== false;

      const collectRowValues = (): Record<string, unknown>[] => {
        const out: Record<string, unknown>[] = [];
        for (const idx of targetRowIndices) {
          const values = extractRowValuesFromIndex(
            idx,
            tableRows,
            effectiveColumns,
            pkCols,
            displayCellOverrides,
          );
          if (values) out.push(values);
        }
        return out;
      };

      const copyText = (text: string) => {
        void writeClipboardText(text);
      };

      const setNullDisabled = (() => {
        if (!onCellSetNull || menu.rowActionsEnabled === false) return true;
        const col = columnMeta?.find((item) => item.name === menu.column);
        if (!col || col.isPk) return true;
        const rowKey = resolvePreviewRowKey(menu.row, pkCols);
        const overrideValue = rowKey ? cellOverrides?.[rowKey]?.[menu.column] : undefined;
        const currentValue = overrideValue !== undefined ? overrideValue : menu.row[menu.column];
        return currentValue == null;
      })();

      return buildTableDataGridContextMenuItems(
        {
          sortDbAsc: t("database.results.contextMenu.sortDbAsc"),
          sortDbDesc: t("database.results.contextMenu.sortDbDesc"),
          sortPageAsc: t("database.results.contextMenu.sortPageAsc"),
          sortPageDesc: t("database.results.contextMenu.sortPageDesc"),
          filter: t("database.results.contextMenu.filter"),
          filterColumn: t("database.results.contextMenu.filterColumn"),
          filterClear: t("database.results.contextMenu.filterClear"),
          cellDetail: t("database.results.contextMenu.cellDetail"),
          columnDetail: t("database.results.contextMenu.columnDetail"),
          rowDetail: t("database.results.contextMenu.rowDetail"),
          copy: t("database.results.contextMenu.copy"),
          copyCell: t("database.results.contextMenu.copyCell"),
          copyRowsJson: t("database.results.contextMenu.copyRowsJson", { count: rowCount }),
          copyInsertMerged: t("database.results.contextMenu.copyInsertMerged", { count: rowCount }),
          copyInsertPerRow: t("database.results.contextMenu.copyInsertPerRow", { count: rowCount }),
          copyInsertNoPkMerged: t("database.results.contextMenu.copyInsertNoPkMerged", {
            count: rowCount,
          }),
          copyInsertNoPkPerRow: t("database.results.contextMenu.copyInsertNoPkPerRow", {
            count: rowCount,
          }),
          copyUpdate: t("database.results.contextMenu.copyUpdate", { count: rowCount }),
          copyAllTsv: t("database.results.contextMenu.copyAllTsv"),
          copyAllColumnNames: t("database.results.contextMenu.copyAllColumnNames"),
          setNull: t("database.cellEditor.setNull"),
          batchEdit: t("database.results.contextMenu.batchEdit"),
          transpose: t("database.results.contextMenu.transpose"),
          selection: t("database.results.contextMenu.selection"),
          selectRow: t("database.results.contextMenu.selectRow"),
          selectColumn: t("database.results.contextMenu.selectColumn"),
          selectAll: t("database.results.contextMenu.selectAll"),
          clearSelection: t("database.results.contextMenu.clearSelection"),
          cloneRows: t("database.results.contextMenu.cloneRows", { count: rowCount }),
          deleteRows: t("database.results.contextMenu.deleteRows", { count: rowCount }),
          export: t("database.results.contextMenu.export"),
        },
        {
          canSortDb: Boolean(enableSort && onSortChange && canSortColumn && !transposed),
          canSortPage: Boolean(canSortColumn && !transposed),
          canFilter: Boolean(canFilter && canSortColumn && !transposed),
          canSetNull: Boolean(onCellSetNull),
          setNullDisabled,
          canBatchEdit: Boolean(onCellEditorFocusRequest),
          canTranspose: Boolean(enableTranspose),
          canClone: Boolean(onRowPaste && !transposed),
          canDelete: Boolean(onDeleteSelectedRows && !transposed),
          canExport: Boolean(onExportMenu),
          canCopySql: Boolean(tableName && !transposed),
          hasSelection: Boolean(currentRange || currentExtraRows.size > 0),
          selectedRowCount: rowCount,
          rowActionsEnabled: menu.rowActionsEnabled !== false && !transposed,
          onSortDbAsc: () => {
            setPageSort(null);
            onSortChange?.({ column: menu.column, direction: "asc" });
          },
          onSortDbDesc: () => {
            setPageSort(null);
            onSortChange?.({ column: menu.column, direction: "desc" });
          },
          onSortPageAsc: () => setPageSort({ column: menu.column, desc: false }),
          onSortPageDesc: () => setPageSort({ column: menu.column, desc: true }),
          onFilterColumn: () => {
            const th = wrapRef.current?.querySelector<HTMLElement>(
              `th[data-col-id="${CSS.escape(menu.column)}"]`,
            );
            if (th) openFilterPopover(th, menu.column);
          },
          onFilterClear: () => onFilterChange?.(null),
          onCellDetail: () => {
            openCellPreview({
              column: menu.column,
              rowIndex: menu.rowIndex,
              row: menu.row,
              value: menu.value,
              columnType: menu.columnType,
              anchor: { left: menu.x, top: menu.y, width: 240, height: 28 },
            });
          },
          onColumnDetail: () => {
            setColSidebarCollapsed(false);
            setNavigatedColumnId(menu.column);
            pendingColumnFocusRef.current = menu.column;
          },
          onRowDetail: () => {
            const maxCol = Math.max(0, leafCount - 1);
            setSelectedRows(new Set());
            setCellRange({
              start: { row: menu.rowIndex, col: 0 },
              end: { row: menu.rowIndex, col: maxCol },
            });
            onOpenRowDetail?.();
            onRowBandSelect?.();
          },
          onCopyCell: () => {
            if (currentRange) {
              copyText(
                buildCellRangeClipboardText(currentRange, leafCols, tableRows, {
                  pkCols,
                  transposed,
                  displayCellOverrides,
                  format: clipboardFormatRef.current,
                }),
              );
              return;
            }
            copyText(formatCellCopyText(menu.value));
          },
          onCopyRowsJson: () => copyText(buildRowsJson(collectRowValues())),
          onCopyInsertMerged: () => {
            if (!tableName) return;
            copyText(
              buildInsertSql({
                dbType,
                tableName,
                columns: resolveCopyColumns(effectiveColumns, columnMeta, false),
                rows: collectRowValues(),
                mode: "merged",
              }),
            );
          },
          onCopyInsertPerRow: () => {
            if (!tableName) return;
            copyText(
              buildInsertSql({
                dbType,
                tableName,
                columns: resolveCopyColumns(effectiveColumns, columnMeta, false),
                rows: collectRowValues(),
                mode: "perRow",
              }),
            );
          },
          onCopyInsertNoPkMerged: () => {
            if (!tableName) return;
            copyText(
              buildInsertSql({
                dbType,
                tableName,
                columns: resolveCopyColumns(effectiveColumns, columnMeta, true),
                rows: collectRowValues(),
                mode: "merged",
              }),
            );
          },
          onCopyInsertNoPkPerRow: () => {
            if (!tableName) return;
            copyText(
              buildInsertSql({
                dbType,
                tableName,
                columns: resolveCopyColumns(effectiveColumns, columnMeta, true),
                rows: collectRowValues(),
                mode: "perRow",
              }),
            );
          },
          onCopyUpdate: () => {
            if (!tableName || pkCols.length === 0) return;
            copyText(
              buildUpdateSql({
                dbType,
                tableName,
                columns: effectiveColumns,
                rows: collectRowValues(),
                pkCols,
              }),
            );
          },
          onCopyAllTsv: () => {
            const allRows = new Set(tableRows.map((_, i) => i));
            copyText(
              buildSelectedRowsClipboardText(allRows, leafCols, tableRows, {
                pkCols,
                transposed,
                displayCellOverrides,
                format: "tsv",
              }),
            );
          },
          onCopyAllColumnNames: () => copyText(buildColumnNamesText(effectiveColumns)),
          onSetNull: () => {
            onCellSetNull?.({
              rowIndex: menu.rowIndex,
              column: menu.column,
              row: menu.row,
            });
          },
          onBatchEdit: () => onCellEditorFocusRequest?.(),
          onTranspose: () => setTransposed((prev) => !prev),
          onSelectRow: () => {
            const maxCol = Math.max(0, leafCount - 1);
            setSelectedRows(new Set());
            setCellRange({
              start: { row: menu.rowIndex, col: 0 },
              end: { row: menu.rowIndex, col: maxCol },
            });
          },
          onSelectColumn: () => {
            const maxRow = Math.max(0, tableRows.length - 1);
            setSelectedRows(new Set());
            setCellRange({
              start: { row: 0, col: menu.colIndex },
              end: { row: maxRow, col: menu.colIndex },
            });
          },
          onSelectAll: () => {
            const maxRow = Math.max(0, tableRows.length - 1);
            const maxCol = Math.max(0, leafCount - 1);
            setSelectedRows(new Set());
            setCellRange({
              start: { row: 0, col: 0 },
              end: { row: maxRow, col: maxCol },
            });
          },
          onClearSelection: () => clearGridSelection(),
          onCloneRows: () => {
            if (!onRowPaste) return;
            for (const values of collectRowValues()) {
              onRowPaste({ values });
            }
          },
          onDeleteRows: () => {
            if (!onDeleteSelectedRows) return;
            const payload = targetRowIndices
              .map((index) => {
                const tableRow = tableRows[index];
                if (!tableRow) return null;
                return { rowIndex: tableRow.index, row: tableRow.original };
              })
              .filter(
                (item): item is { rowIndex: number; row: Record<string, unknown> } => item != null,
              );
            if (payload.length === 0) return;
            onDeleteSelectedRows(payload);
            clearGridSelection();
          },
          onExport: () => onExportMenu?.(menu.x, menu.y),
        },
      );
    },
    [
      table,
      transposed,
      tableRows,
      effectiveColumns,
      pkCols,
      displayCellOverrides,
      writeClipboardText,
      onCellSetNull,
      columnMeta,
      cellOverrides,
      t,
      enableSort,
      onSortChange,
      canFilter,
      openFilterPopover,
      onFilterChange,
      openCellPreview,
      onOpenRowDetail,
      onRowBandSelect,
      onCellEditorFocusRequest,
      enableTranspose,
      setTransposed,
      onRowPaste,
      onDeleteSelectedRows,
      onExportMenu,
      tableName,
      dbType,
      clearGridSelection,
    ],
  );

  bodyActionsRef.current = {
    beginRowResize,
    handleRowBandSelect,
    handleRowBandDoubleClick,
    handleDataCellMouseDown,
    handleDataCellDoubleClick,
    handleDataCellContextMenu,
    handleOpenValuePanel: onCellEditorFocusRequest
      ? (ctx) => {
          setSelectedRows(new Set());
          cellDragRef.current = null;
          rowDragRef.current = null;
          const anchor = { row: ctx.rowIndex, col: ctx.colIndex };
          cellAnchorRef.current = anchor;
          rowAnchorRef.current = ctx.rowIndex;
          setCellRange({ start: anchor, end: anchor });
          onCellEditorFocusRequest();
        }
      : undefined,
  };

  const buildGridBodyRowProps = useCallback(
    (rowIndex: number) => {
      const row = tableRows[rowIndex];
      if (!row) return null;
      const rowKey = transposed
        ? String(row.original[TRANSPOSE_FIELD_COL] ?? "")
        : resolvePreviewRowKey(row.original, pkCols);
      const rowChangeKind: PreviewRowChangeKind = transposed
        ? rowKey && displayDirtyRowKeys?.has(rowKey)
          ? "update"
          : "none"
        : resolvePreviewRowChangeKind(rowKey, deletedRowKeys ?? EMPTY_DELETED_ROW_KEYS, displayDirtyRowKeys);
      return {
        rowDirty: rowChangeKind !== "none",
        rowChangeKind,
        overrideForRow: rowKey ? displayCellOverrides?.[rowKey] : undefined,
        rowHeight: rowHeights[row.index],
        cellRange,
        selectedRows,
        staticConfig: gridBodyStaticConfig,
      };
    },
    [
      tableRows,
      transposed,
      pkCols,
      displayDirtyRowKeys,
      deletedRowKeys,
      displayCellOverrides,
      rowHeights,
      cellRange,
      selectedRows,
      gridBodyStaticConfig,
    ],
  );

  if (effectiveColumns.length === 0) {
    return null;
  }

  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const showingFrom = totalRows === 0 ? 0 : page * pageSize + 1;
  const showingTo = Math.min((page + 1) * pageSize, totalRows);

  return (
    <div className="db-data-table-panel">
    <div className="db-data-table-body">
      {!colSidebarCollapsed ? (
        <ColumnVisibilitySidebar
          columns={sidebarColumns}
          columnMetaMap={columnMetaMap}
          hiddenColumns={hiddenColumns}
          onChange={setHiddenColumns}
          activeColumn={navigatedColumnId}
          onColumnNavigate={handleColumnNavigate}
          columnLabels={sidebarColumnLabels}
          isColumnVisible={isSidebarColumnVisible}
          columnItemClassName={sidebarColumnItemClassName}
        />
      ) : null}
      <div className="db-data-table-main">
    {allColumnsHidden ? (
      <div className="db-data-table-all-hidden">
        {t("database.results.columnVisibilityAllHidden")}
      </div>
    ) : (
    <div
      ref={wrapRef}
      className={`db-data-table-wrap${useRowVirtualization ? " db-data-table-wrap--virtual" : ""}${transposed ? " db-data-table-wrap--transposed" : ""}${loading ? " db-data-table-wrap--loading" : ""}${isPaging ? " db-data-table-wrap--paging" : ""}`}
    >
      <table
        className="db-data-table"
        style={{ width: fillDelta > 0 ? "100%" : totalTableWidth, minWidth: "100%" }}
      >
        <colgroup>
          {columnLayout.enabled ? (
            <>
              {columnLayout.pinnedIndices.map((colIndex) => {
                const column = leafColumns[colIndex];
                if (!column) return null;
                return (
                  <col
                    key={column.id}
                    data-col-id={column.id}
                    style={{ width: resolveColumnWidth(column.id, column.getSize()) }}
                  />
                );
              })}
              {columnLayout.paddingLeft > 0 ? (
                <col key="__col_pad_l" style={{ width: columnLayout.paddingLeft }} />
              ) : null}
              {columnLayout.virtualIndices.map((colIndex) => {
                const column = leafColumns[colIndex];
                if (!column) return null;
                return (
                  <col
                    key={column.id}
                    data-col-id={column.id}
                    style={{ width: resolveColumnWidth(column.id, column.getSize()) }}
                  />
                );
              })}
              {columnLayout.paddingRight > 0 ? (
                <col key="__col_pad_r" style={{ width: columnLayout.paddingRight }} />
              ) : null}
            </>
          ) : (
            leafColumns.map((column) => (
              <col
                key={column.id}
                data-col-id={column.id}
                style={{ width: resolveColumnWidth(column.id, column.getSize()) }}
              />
            ))
          )}
        </colgroup>
        <thead>
                {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {(columnLayout.enabled
                ? [
                    ...columnLayout.pinnedIndices.map((i) => ({ kind: "col" as const, i })),
                    ...(columnLayout.paddingLeft > 0
                      ? [{ kind: "pad" as const, key: "l", width: columnLayout.paddingLeft }]
                      : []),
                    ...columnLayout.virtualIndices.map((i) => ({ kind: "col" as const, i })),
                    ...(columnLayout.paddingRight > 0
                      ? [{ kind: "pad" as const, key: "r", width: columnLayout.paddingRight }]
                      : []),
                  ]
                : headerGroup.headers.map((_, i) => ({ kind: "col" as const, i }))
              ).map((item) => {
                if (item.kind === "pad") {
                  return (
                    <th
                      key={`__th_pad_${item.key}`}
                      aria-hidden
                      style={{
                        width: item.width,
                        minWidth: item.width,
                        padding: 0,
                        border: "none",
                      }}
                    />
                  );
                }
                const headerColIdx = item.i;
                const header = headerGroup.headers[headerColIdx];
                if (!header) return null;
                const baseSize = header.getSize();
                const colId = header.column.id;
                const isFieldCol = transposed && colId === TRANSPOSE_FIELD_COL;
                const isRelationDisplayCol = !transposed && isRelationDisplayColumn(colId);
                const isSelectAllHeader = colId === ROW_NUM_COL_ID || isFieldCol;
                const canSort =
                  enableSort && !transposed && colId !== ROW_NUM_COL_ID;
                const sortActive = canSort && sort?.column === colId;
                const sortDirection = sortActive ? sort!.direction : null;
                const sortClass = sortActive
                  ? sortDirection === "asc"
                    ? " db-data-table-th--sort-asc"
                    : " db-data-table-th--sort-desc"
                  : "";
                const filterClass =
                  canFilter && !transposed && colId !== ROW_NUM_COL_ID && filterColumnNames.has(colId)
                    ? " db-data-table-th--filtered"
                    : "";
                const relationSourceCol = isRelationDisplayCol ? relationSourceColumn(colId) : colId;
                const relation =
                  !transposed && colId !== ROW_NUM_COL_ID && !isFieldCol && !isRelationDisplayCol
                    ? columnRelations[colId]
                    : undefined;
                const relatedTableForRelation = relation
                  ? relationTables?.find((table) => table.name === relation.tableName)
                  : undefined;
                const relationActive = Boolean(relation);
                const relationLabel = formatColumnRelationLabel(relation, relatedTableForRelation);
                const thSelected = isHeaderInColumnSelection(headerColIdx, cellRange, tableRows.length);
                const colMeta =
                  !transposed && !isFieldCol && colId !== ROW_NUM_COL_ID && !isRelationDisplayCol
                    ? columnMetaMap?.[colId]
                    : undefined;
                const relationDisplayHeader =
                  isRelationDisplayCol && relationSourceCol
                    ? (() => {
                        const sourceRelation = columnRelations[relationSourceCol];
                        if (!sourceRelation) return colId;
                        const relatedTable = relationTables?.find(
                          (table) => table.name === sourceRelation.tableName,
                        );
                        return buildRelationDisplayColumnLabel(sourceRelation, relatedTable);
                      })()
                    : null;
                const headerTitle = isSelectAllHeader
                  ? t("database.results.selectAll")
                  : colMeta
                    ? buildColumnHeaderTooltip(colMeta, colId, t)
                    : relationDisplayHeader
                      ? relationDisplayHeader
                      : colId !== ROW_NUM_COL_ID
                        ? colId
                        : undefined;
                return (
                <th
                  key={header.id}
                  data-col-id={colId}
                  style={buildColumnCellStyle(colId, baseSize, lastColumnId, fillDelta)}
                  className={`${table.getState().columnSizingInfo?.isResizingColumn === colId ? "db-data-table-th-resizing" : ""}${canSort ? " db-data-table-th--sortable" : ""}${isSelectAllHeader || colId !== ROW_NUM_COL_ID ? " db-data-table-th--selectable" : ""}${isSelectAllHeader ? " db-data-table-th--select-all" : ""}${thSelected ? " db-data-table-th--selected" : ""}${sortClass}${filterClass}${relationActive ? " db-data-table-th--relation" : ""}${isRelationDisplayCol ? " db-data-table-th--relation-display" : ""}`}
                  onClick={
                    isSelectAllHeader
                      ? handleSelectAll
                      : () => handleColumnSelect(colId)
                  }
                  onDoubleClick={(e) => handleTransposeRowHeaderDoubleClick(colId, e)}
                  title={headerTitle}
                >
                  {header.isPlaceholder ? null : (
                    <span className="db-data-table-th-inner">
                      <span className="db-data-table-th-label">
                        {flexRender(header.column.columnDef.header, header.getContext())}
                      </span>
                      {(canSort || (canFilter && colId !== ROW_NUM_COL_ID && !transposed && !isRelationDisplayCol)) && (
                        <span className="db-data-table-th-actions">
                          {canSort && (
                            <ColumnSortIndicator
                              active={sortActive}
                              direction={sortActive ? sortDirection : null}
                              title={t("database.results.sortHint")}
                              onClick={(event) => {
                                event.stopPropagation();
                                handleHeaderClick(colId);
                              }}
                            />
                          )}
                          {canFilter &&
                            colId !== ROW_NUM_COL_ID &&
                            !transposed &&
                            !isRelationDisplayCol && (
                            <ColumnFilterButton
                              columnName={colId}
                              active={filterColumnNames.has(colId)}
                              onOpen={openFilterPopover}
                            />
                          )}
                        </span>
                      )}
                      {canConfigureRelation &&
                      colId !== ROW_NUM_COL_ID &&
                      !transposed &&
                      !isFieldCol &&
                      !isRelationDisplayCol ? (
                        <span className="db-data-table-th-relation">
                          <ColumnRelationButton
                            columnName={colId}
                            active={relationActive}
                            relationLabel={relationLabel}
                            onOpen={openRelationDialog}
                          />
                        </span>
                      ) : null}
                      {isRelationDisplayCol && relationSourceCol ? (
                        <span className="db-data-table-th-relation-display-actions-wrap">
                          {canSort && (
                            <ColumnSortIndicator
                              active={sortActive}
                              direction={sortActive ? sortDirection : null}
                              title={t("database.results.sortHint")}
                              onClick={(event) => {
                                event.stopPropagation();
                                handleHeaderClick(colId);
                              }}
                            />
                          )}
                          {canFilter && (
                            <ColumnFilterButton
                              columnName={colId}
                              active={filterColumnNames.has(colId)}
                              onOpen={openFilterPopover}
                            />
                          )}
                          <ColumnRelationDisplayActions
                            onEdit={() => openRelationDialog(relationSourceCol)}
                            onDelete={() => setRelationDeleteSourceColumn(relationSourceCol)}
                          />
                        </span>
                      ) : null}
                    </span>
                  )}
                  {header.column.getCanResize() && (
                    <div
                      className="db-col-resize-handle"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const startWidth = header.getSize();
                        colResizeRef.current = {
                          columnId: colId,
                          startX: e.clientX,
                          startWidth,
                          lastWidth: startWidth,
                        };
                        wrapRef.current?.classList.add("db-data-table-wrap--col-resizing");
                        wrapRef.current
                          ?.querySelector(`th[data-col-id="${CSS.escape(colId)}"]`)
                          ?.classList.add("db-data-table-th-resizing");
                      }}
                      onDoubleClick={() => header.column.resetSize()}
                      title="Drag to resize"
                    />
                  )}
                </th>
              );
            })}
            </tr>
          ))}
        </thead>
        {useRowVirtualization ? (
          <TableDataGridVirtualBody
            ref={virtualBodyRef}
            scrollElementRef={wrapRef}
            tableRows={tableRows}
            getRowHeight={getRowHeight}
            rowHeights={rowHeights}
            visibleCellCount={columnLayout.visibleCellCount}
            buildRowProps={buildGridBodyRowProps}
            bodyActionsRef={bodyActionsRef}
            resolveCellContext={resolveBodyCellContext}
          />
        ) : (
          <TableDataGridBody
            tableRows={tableRows}
            buildRowProps={buildGridBodyRowProps}
            bodyActionsRef={bodyActionsRef}
            resolveCellContext={resolveBodyCellContext}
          />
        )}
      </table>
      <TableDataGridCellOverlay
        overlay={cellOverlay}
        onEditChange={handleCellOverlayEditChange}
        onEditCommit={commitCellOverlayEdit}
        onEditCancel={cancelCellOverlayEdit}
      />
    </div>
    )}
    {!allColumnsHidden && (
      <TableDataGridCellContextMenu
        menuOpenRef={cellMenuOpenRef}
        buildItems={buildCellContextMenuItems}
      />
    )}
    </div>
    </div>
    {chromePlacement === "bottom" ? (
    <div className="db-pagination">
      <Button
        variant={!colSidebarCollapsed ? "default" : "ghost"}
        size="sm"
        className="db-col-sidebar-footer-toggle"
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
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => setColSidebarCollapsed((prev) => !prev)}
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          width="14"
          height="14"
          aria-hidden
          className={colSidebarCollapsed ? undefined : "db-col-sidebar-footer-toggle-icon--expanded"}
        >
          <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
          <path d="M5 2.5v11M9.5 2.5v11" />
        </svg>
      </Button>
      <div className="db-pagination-left">
        {onDeleteSelectedRows ? (
          <div className="db-delete-selected-rows-wrap">
            <Button
              variant="ghost"
              size="icon-sm"
              className="db-delete-selected-rows"
              disabled={!hasSelectedRows || loading}
              title={
                hasSelectedRows
                  ? t("database.results.deleteSelectedRows", { count: selectedRowIndices.length })
                  : t("database.results.deleteSelectedRowsDisabled")
              }
              aria-label={
                hasSelectedRows
                  ? t("database.results.deleteSelectedRows", { count: selectedRowIndices.length })
                  : t("database.results.deleteSelectedRowsDisabled")
              }
              onClick={handleDeleteSelectedRows}
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
                <path d="M3 4.5h10M6 4.5V3.25A1.25 1.25 0 0 1 7.25 2h1.5A1.25 1.25 0 0 1 10 3.25V4.5M6.25 7v4.5M9.75 7v4.5M4.25 4.5l.5 8.25A1.25 1.25 0 0 0 5.75 14h4.5a1.25 1.25 0 0 0 1.25-1.25l.5-8.25" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </Button>
            {hasSelectedRows ? (
              <span className="db-delete-selected-rows-badge">{selectedRowIndices.length}</span>
            ) : null}
          </div>
        ) : null}
        {toolbar ? <div className="db-pagination-toolbar">{toolbar}</div> : null}
        <div className="db-pagination-info">
        {enableTranspose && (
          <Button
            variant={transposed ? "default" : "ghost"}
            size="sm"
            className="db-transpose-toggle"
            title={transposed ? t("database.results.transposeOff") : t("database.results.transposeOn")}
            aria-label={transposed ? t("database.results.transposeOff") : t("database.results.transposeOn")}
            aria-pressed={transposed}
            onClick={() => setTransposed((prev) => !prev)}
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
              <rect x="1.5" y="1.5" width="5" height="5" rx="0.75" />
              <rect x="9.5" y="9.5" width="5" height="5" rx="0.75" />
              <path d="M6.5 4h3M4 6.5v3M12 9.5v3M9.5 12h3" strokeLinecap="round" />
            </svg>
          </Button>
        )}
        {canCopyPreviewSql && (
          <Button
            variant={copySqlHint ? "default" : "ghost"}
            size="sm"
            className="db-copy-preview-sql"
            type="button"
            title={copySqlHint ? t("database.results.copyPreviewSqlDone") : previewSql}
            aria-label={t("database.results.copyPreviewSql")}
            onClick={() => void handleCopyPreviewSql()}
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
              <rect x="5" y="5" width="8" height="9" rx="1" />
              <path d="M4 11V3.5A1.5 1.5 0 0 1 5.5 2H11" strokeLinecap="round" />
            </svg>
          </Button>
        )}
        {loading && !isPaging ? (
          <span>{t("common.loading")}</span>
        ) : totalRows > 0 ? (
          <span className={isPaging ? "db-pagination-info--paging" : undefined}>
            {showingFrom.toLocaleString()}–{showingTo.toLocaleString()} of{" "}
            {totalRows.toLocaleString()} rows
            {isPaging ? ` · ${t("common.loading")}` : ""}
          </span>
        ) : (
          <span>0 rows</span>
        )}
        </div>
      </div>
      {footerExtra ? <div className="db-pagination-extra">{footerExtra}</div> : null}
      {onCellEditorCollapsedChange ? (
        <Button
          variant={!cellEditorCollapsed ? "default" : "ghost"}
          size="sm"
          className="db-cell-editor-footer-toggle"
          title={
            cellEditorCollapsed
              ? t("database.results.cellEditorExpand")
              : t("database.results.cellEditorCollapse")
          }
          aria-label={
            cellEditorCollapsed
              ? t("database.results.cellEditorExpand")
              : t("database.results.cellEditorCollapse")
          }
          aria-expanded={!cellEditorCollapsed}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={onCellEditorCollapsedChange}
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            width="14"
            height="14"
            aria-hidden
            className={cellEditorCollapsed ? undefined : "db-cell-editor-footer-toggle-icon--expanded"}
          >
            <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
            <path d="M2 9h12" />
            <path
              d={cellEditorCollapsed ? "M8 10.5V6M6 8.5l2-2 2 2" : "M8 7.5v4.5M6 9.5l2 2 2-2"}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </Button>
      ) : null}
      {(onOpenTableDesign || onCreateTableQuery) ? (
        <div className="db-pagination-quick-actions">
          {onOpenTableDesign ? (
            <Button
              variant="icon"
              size="icon-sm"
              disabled={!canOpenTableDesign || loading}
              title={t("database.contextMenu.designTable")}
              aria-label={t("database.contextMenu.designTable")}
              onClick={onOpenTableDesign}
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" width="14" height="14" aria-hidden>
                <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
                <path d="M5 8h6M8 5v6" />
              </svg>
            </Button>
          ) : null}
          {onCreateTableQuery ? (
            <Button
              variant="icon"
              size="icon-sm"
              disabled={!canCreateTableQuery || loading}
              title={t("database.workspace.newQuery")}
              aria-label={t("database.workspace.newQuery")}
              onClick={onCreateTableQuery}
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" width="14" height="14" aria-hidden>
                <path d="M3 4.5h10M3 8h10M3 11.5h6" strokeLinecap="round" />
                <path d="M11.5 8.5 13 10l-2 2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="db-pagination-controls">
        <Button
          variant="ghost"
          size="sm"
          disabled={page <= 0 || loading}
          onClick={() => handlePageChange(0)}
          title={t("database.results.paginationFirst")}
          aria-label={t("database.results.paginationFirst")}
        >
          «
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={page <= 0 || loading}
          onClick={() => handlePageChange(page - 1)}
          title={t("database.results.paginationPrev")}
          aria-label={t("database.results.paginationPrev")}
        >
          ‹
        </Button>
        {totalPages > 0 && (
          <span className="db-pagination-pages">
            {page + 1} / {totalPages}
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={page >= totalPages - 1 || loading}
          onClick={() => handlePageChange(page + 1)}
          title={t("database.results.paginationNext")}
          aria-label={t("database.results.paginationNext")}
        >
          ›
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={page >= totalPages - 1 || loading}
          onClick={() => handlePageChange(totalPages - 1)}
          title={t("database.results.paginationLast")}
          aria-label={t("database.results.paginationLast")}
        >
          »
        </Button>
      </div>
    </div>
    ) : null}
    {filterOpen && filterAnchorRect && filterLockedField && columnMeta && onFilterChange && (
      <TableDataGridFilterPopover
        anchorRect={filterAnchorRect}
        columnMeta={columnMeta}
        columnRelations={columnRelations}
        relationTables={relationTables}
        initialQuery={filter}
        lockedField={filterLockedField}
        onApply={onFilterChange}
        onClose={() => setFilterOpen(false)}
      />
    )}
    {relationDialogColumn && relationTables && relationTables.length > 0 ? (
      <TableColumnRelationDialog
        open
        onClose={() => setRelationDialogColumn(null)}
        columnName={relationDialogColumn}
        tables={relationTables}
        initial={columnRelations[relationDialogColumn] ?? null}
        onConfirm={handleRelationConfirm}
      />
    ) : null}
    <WarnAlert
      open={relationDeleteSourceColumn != null}
      title={t("database.results.relationDeleteTitle")}
      message={t("database.results.relationDeleteMessage", {
        column: relationDeleteSourceColumn ?? "",
      })}
      confirmLabel={t("common.delete")}
      cancelLabel={t("common.cancel")}
      onConfirm={handleRelationDeleteConfirm}
      onClose={() => setRelationDeleteSourceColumn(null)}
    />
    <TableCellPreviewSubWindow
      open={cellPreviewState != null}
      preview={cellPreviewState}
      onClose={closeCellPreview}
    />
    </div>
  );
});
