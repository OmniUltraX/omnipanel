import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  memo,
  type MutableRefObject,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnSizingState,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { RuleGroupType } from "react-querybuilder";

import { Button } from "../../components/ui/Button";
import { ContextMenu } from "../../components/ui/ContextMenu";
import { useI18n } from "../../i18n";
import { textSearchMatches } from "../../lib/textSearchMatch";
import { type DbColumnMeta } from "./api";
import { PENDING_INSERT_ROW_KEY, type SortState } from "./dbWorkspaceState";
import { getFilterColumnNames, buildTablePreviewSql } from "./tablePreviewFilter";
import { TableDataGridFilterPopover } from "./TableDataGridFilterPopover";
import {
  TableDataGridCellPreviewDrawer,
  type TableDataGridCellPreview,
} from "./TableDataGridCellPreviewDrawer";

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
  onRowEdit?: (cellInfo: { rowIndex: number; column: string; row: Record<string, unknown> }) => void;
  onCellSetNull?: (cellInfo: { rowIndex: number; column: string; row: Record<string, unknown> }) => void;
  /** 已修改的行 key 集合（来自父组件脏数据状态），用于高亮 */
  dirtyRowKeys?: Set<string>;
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
};

function buildRowKey(row: Record<string, unknown>, pkCols: { name: string }[]): string {
  if (pkCols.length === 0) return "";
  return pkCols
    .map((pk) => `${pk.name}=${row[pk.name] == null ? "" : String(row[pk.name])}`)
    .join("&");
}

function resolveRowKey(
  row: Record<string, unknown>,
  pkCols: { name: string }[],
): string {
  const pendingKey = row[PENDING_INSERT_ROW_KEY];
  if (typeof pendingKey === "string") return pendingKey;
  if (pkCols.length === 0) return "";
  return buildRowKey(row, pkCols);
}

const MIN_ROW_HEIGHT = 28;
const DEFAULT_ROW_HEIGHT = 36;
const ROW_RESIZE_ZONE_PX = 8;
const COLUMN_MIN_WIDTH = 60;
const ROW_NUM_COL_ID = '__row_num__';

type CellPos = { row: number; col: number };
type CellRange = { start: CellPos; end: CellPos };

function normalizeRange(range: CellRange): { minRow: number; maxRow: number; minCol: number; maxCol: number } {
  return {
    minRow: Math.min(range.start.row, range.end.row),
    maxRow: Math.max(range.start.row, range.end.row),
    minCol: Math.min(range.start.col, range.end.col),
    maxCol: Math.max(range.start.col, range.end.col),
  };
}

function isCellInRange(row: number, col: number, range: CellRange | null): boolean {
  if (!range) return false;
  const r = normalizeRange(range);
  return row >= r.minRow && row <= r.maxRow && col >= r.minCol && col <= r.maxCol;
}

/** 列头高亮：选区覆盖全部行且包含该列 */
function isHeaderInColumnSelection(
  headerColIdx: number,
  range: CellRange | null,
  rowCount: number,
): boolean {
  if (!range || rowCount <= 0) return false;
  const r = normalizeRange(range);
  const spansAllRows = r.minRow === 0 && r.maxRow === rowCount - 1;
  if (!spansAllRows) return false;
  return headerColIdx >= r.minCol && headerColIdx <= r.maxCol;
}

function cellToText(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function buildColumnHeaderTooltip(
  meta: DbColumnMeta | undefined,
  columnName: string,
  t: (key: string) => string,
): string {
  const lines: string[] = [columnName];
  if (meta?.type) {
    lines.push(meta.type);
  }
  const comment = meta?.comment?.trim();
  if (comment) {
    lines.push(comment);
  }
  if (meta !== undefined && meta.nullable !== undefined) {
    lines.push(
      meta.nullable
        ? t("database.results.columnNullable")
        : t("database.results.columnNotNullable"),
    );
  }
  return lines.join("\n");
}

function ColumnHeaderLabel({
  label,
  meta,
  t,
}: {
  label: string;
  meta?: DbColumnMeta;
  t: (key: string) => string;
}) {
  const showNotNull = meta?.nullable === false;
  return (
    <span className="db-data-table-th-label-wrap">
      <span className="db-data-table-th-name">{label}</span>
      {showNotNull ? (
        <span
          className="db-data-table-th-nullability db-data-table-th-nullability--no"
          title={t("database.results.columnNotNullable")}
        >
          {t("database.results.columnNotNullableShort")}
        </span>
      ) : null}
    </span>
  );
}

function isNearRowBottom(target: HTMLElement, clientY: number): boolean {
  const rect = target.getBoundingClientRect();
  return clientY >= rect.bottom - ROW_RESIZE_ZONE_PX;
}

/** 清除 WebView 在 DOM 更新后粘住的 :hover 伪类 */
function resetStuckPointerHover(container: HTMLElement | null) {
  if (!container) return;
  container.style.pointerEvents = "none";
  void container.offsetHeight;
  container.style.pointerEvents = "";
}

const TRANSPOSE_FIELD_COL = "__field__";
const transposeRowColId = (index: number) => `__row__${index}`;

function buildTransposeRowHeader(
  row: Record<string, unknown>,
  rowIndex: number,
  page: number,
  pageSize: number,
  columnMeta?: DbColumnMeta[],
): string {
  const pkCols = (columnMeta ?? []).filter((c) => c.isPk);
  if (pkCols.length > 0) {
    const label = pkCols
      .map((pk) => row[pk.name])
      .filter((v) => v != null && v !== "")
      .map(String)
      .join(", ");
    if (label) return label;
  }
  return String(page * pageSize + rowIndex + 1);
}

function transposeGridData(
  columns: string[],
  rows: Record<string, unknown>[],
  page: number,
  pageSize: number,
  columnMeta?: DbColumnMeta[],
): {
  columns: string[];
  rows: Record<string, unknown>[];
  rowHeaders: string[];
} {
  const rowHeaders = rows.map((row, i) =>
    buildTransposeRowHeader(row, i, page, pageSize, columnMeta),
  );
  const transposedColumns = [TRANSPOSE_FIELD_COL, ...rows.map((_, i) => transposeRowColId(i))];
  const transposedRows = columns.map((col) => {
    const record: Record<string, unknown> = { [TRANSPOSE_FIELD_COL]: col };
    rows.forEach((dataRow, i) => {
      record[transposeRowColId(i)] = dataRow[col];
    });
    return record;
  });
  return { columns: transposedColumns, rows: transposedRows, rowHeaders };
}

function transposeDirtyState(
  rows: Record<string, unknown>[],
  columnMeta: DbColumnMeta[] | undefined,
  dirtyRowKeys: Set<string> | undefined,
  cellOverrides: Record<string, Record<string, unknown>> | undefined,
): {
  dirtyRowKeys: Set<string>;
  cellOverrides: Record<string, Record<string, unknown>>;
} {
  const transposedDirty = new Set<string>();
  const transposedOverrides: Record<string, Record<string, unknown>> = {};
  if (!dirtyRowKeys?.size || !cellOverrides) {
    return { dirtyRowKeys: transposedDirty, cellOverrides: transposedOverrides };
  }

  const pkCols = (columnMeta ?? []).filter((c) => c.isPk);
  rows.forEach((row, rowIndex) => {
    const rowKey = pkCols.length > 0 ? buildRowKey(row, pkCols) : "";
    if (!rowKey || !dirtyRowKeys.has(rowKey)) return;
    const overrides = cellOverrides[rowKey];
    if (!overrides) return;
    for (const [col, value] of Object.entries(overrides)) {
      transposedDirty.add(col);
      if (!transposedOverrides[col]) transposedOverrides[col] = {};
      transposedOverrides[col][transposeRowColId(rowIndex)] = value;
    }
  });

  return { dirtyRowKeys: transposedDirty, cellOverrides: transposedOverrides };
}

type CellMenuState = {
  x: number;
  y: number;
  rowIndex: number;
  column: string;
  row: Record<string, unknown>;
};

function applyColumnWidthDom(wrap: HTMLElement, columnId: string, width: number) {
  const px = `${width}px`;
  wrap.querySelectorAll<HTMLElement>(`[data-col-id="${CSS.escape(columnId)}"]`).forEach((el) => {
    el.style.width = px;
  });
  wrap
    .querySelector<HTMLElement>(`col[data-col-id="${CSS.escape(columnId)}"]`)
    ?.style.setProperty("width", px);
}

function buildColumnCellStyle(
  columnId: string,
  baseSize: number,
  lastColumnId: string,
  fillDelta: number,
): CSSProperties {
  const stretchLast = fillDelta > 0 && columnId === lastColumnId;
  const width = stretchLast ? baseSize + fillDelta : baseSize;
  return stretchLast
    ? { width, minWidth: baseSize }
    : { width, minWidth: baseSize, maxWidth: baseSize };
}

function TableCellContextMenu({
  menuOpenRef,
  onRowEdit,
  onCellSetNull,
  columnMeta,
  cellOverrides,
}: {
  menuOpenRef: MutableRefObject<(state: CellMenuState) => void>;
  onRowEdit: (info: { rowIndex: number; column: string; row: Record<string, unknown> }) => void;
  onCellSetNull?: (info: { rowIndex: number; column: string; row: Record<string, unknown> }) => void;
  columnMeta?: DbColumnMeta[];
  cellOverrides?: Record<string, Record<string, unknown>>;
}) {
  const { t } = useI18n();
  const [menu, setMenu] = useState<CellMenuState | null>(null);

  useEffect(() => {
    menuOpenRef.current = setMenu;
    return () => {
      menuOpenRef.current = () => {};
    };
  }, [menuOpenRef]);

  const handleEditRow = useCallback(() => {
    if (!menu) return;
    onRowEdit({
      rowIndex: menu.rowIndex,
      column: menu.column,
      row: menu.row,
    });
    setMenu(null);
  }, [menu, onRowEdit]);

  const handleSetNull = useCallback(() => {
    if (!menu || !onCellSetNull) return;
    onCellSetNull({
      rowIndex: menu.rowIndex,
      column: menu.column,
      row: menu.row,
    });
    setMenu(null);
  }, [menu, onCellSetNull]);

  const setNullDisabled = useMemo(() => {
    if (!menu || !onCellSetNull) return true;
    const col = columnMeta?.find((item) => item.name === menu.column);
    if (!col || col.isPk) return true;
    const pkCols = (columnMeta ?? []).filter((item) => item.isPk);
    const rowKey = resolveRowKey(menu.row, pkCols);
    const overrideValue = rowKey ? cellOverrides?.[rowKey]?.[menu.column] : undefined;
    const currentValue = overrideValue !== undefined ? overrideValue : menu.row[menu.column];
    return currentValue == null;
  }, [menu, onCellSetNull, columnMeta, cellOverrides]);

  const items = useMemo(
    () => [
      {
        id: "edit-row",
        label: t("database.rowEditor.contextMenu"),
        onClick: handleEditRow,
      },
      {
        id: "set-null",
        label: t("database.cellEditor.setNull"),
        disabled: setNullDisabled,
        onClick: handleSetNull,
      },
    ],
    [t, handleEditRow, handleSetNull, setNullDisabled],
  );

  if (!menu) return null;

  return (
    <ContextMenu
      position={{ x: menu.x, y: menu.y }}
      onClose={() => setMenu(null)}
      items={items}
    />
  );
}

function ColumnVisibilityPopover({
  anchorRect,
  columns,
  hiddenColumns,
  onChange,
  onClose,
}: {
  anchorRect: DOMRect;
  columns: string[];
  hiddenColumns: Set<string>;
  onChange: (next: Set<string>) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }, []);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [onClose]);

  const q = query.trim();
  const filteredColumns = useMemo(
    () => (q ? columns.filter((c) => textSearchMatches(q, c)) : columns),
    [columns, q],
  );

  const visibleCount = columns.length - hiddenColumns.size;
  const allVisible = columns.length > 0 && visibleCount === columns.length;

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = visibleCount > 0 && visibleCount < columns.length;
    }
  }, [visibleCount, columns.length]);

  const toggleOne = useCallback(
    (name: string) => {
      const next = new Set(hiddenColumns);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      onChange(next);
    },
    [hiddenColumns, onChange],
  );

  const toggleAll = useCallback(() => {
    onChange(allVisible ? new Set(columns) : new Set());
  }, [allVisible, columns, onChange]);

  const margin = 8;
  const maxLeft = Math.max(margin, Math.min(window.innerWidth - 320 - margin, anchorRect.left));
  const top = Math.min(
    Math.max(margin, anchorRect.bottom + 4),
    window.innerHeight - 360 - margin,
  );

  return createPortal(
    <div
      ref={ref}
      className="db-col-visibility-popover"
      style={{ left: maxLeft, top }}
      role="dialog"
      aria-label={t("database.results.columnVisibilityTitle")}
    >
      <div className="db-col-visibility-popover-header">
        <span className="db-col-visibility-popover-title">
          {t("database.results.columnVisibilityTitle")}
        </span>
      </div>
      <label className="db-col-visibility-popover-select-all">
        <input
          ref={selectAllRef}
          type="checkbox"
          checked={allVisible}
          onChange={toggleAll}
        />
        <span>{t("database.results.columnVisibilityToggleAll")}</span>
        <span className="db-col-visibility-popover-select-all-count">
          {t("database.results.columnVisibilitySelected", {
            count: visibleCount,
            total: columns.length,
          })}
        </span>
      </label>
      <div className="db-col-visibility-popover-search">
        <svg
          viewBox="0 0 16 16"
          className="db-col-visibility-popover-search-icon"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          aria-hidden
        >
          <circle cx="7" cy="7" r="4.5" />
          <path d="M10.5 10.5L14 14" strokeLinecap="round" />
        </svg>
        <input
          ref={searchInputRef}
          type="text"
          className="db-col-visibility-popover-search-input"
          placeholder={t("database.results.columnVisibilitySearch")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <ul className="db-col-visibility-popover-list">
        {filteredColumns.length === 0 ? (
          <li className="db-col-visibility-popover-empty">
            {t("database.results.columnVisibilityNoResults")}
          </li>
        ) : (
          filteredColumns.map((name) => {
            const checked = !hiddenColumns.has(name);
            return (
              <li
                key={name}
                className="db-col-visibility-popover-item"
                onClick={() => toggleOne(name)}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleOne(name)}
                  onClick={(e) => e.stopPropagation()}
                />
                <span className="db-col-visibility-popover-item-name" title={name}>
                  {name}
                </span>
              </li>
            );
          })
        )}
      </ul>
    </div>,
    document.body,
  );
}

export const TableDataGrid = memo(function TableDataGrid({ columns, rows, totalRows, page, pageSize, loading, onPageChange, columnMeta, onCellEdit, onRowEdit, onCellSetNull, dirtyRowKeys, cellOverrides, enableTranspose = false, toolbar, sort = null, onSortChange, enableSort = false, filter = null, onFilterChange, enableFilter = false, dbType, tableName, hiddenColumns: hiddenColumnsProp, onHiddenColumnsChange, transposed: transposedProp, onTransposedChange }: TableDataGridProps) {
  const { t } = useI18n();
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
  const [cellPreview, setCellPreview] = useState<TableDataGridCellPreview | null>(null);
  const [colVisOpen, setColVisOpen] = useState(false);
  const colVisAnchorRef = useRef<HTMLButtonElement>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterLockedField, setFilterLockedField] = useState<string | null>(null);
  const [filterAnchorRect, setFilterAnchorRect] = useState<DOMRect | null>(null);
  const [copySqlHint, setCopySqlHint] = useState(false);
  const copySqlHintTimerRef = useRef<number | null>(null);
  const cellMenuOpenRef = useRef<(state: CellMenuState) => void>(() => {});
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
  const [containerWidth, setContainerWidth] = useState(0);
  const savedScrollRef = useRef({ left: 0, top: 0 });
  const restoreScrollAfterPageChangeRef = useRef(false);
  const [cellRange, setCellRange] = useState<CellRange | null>(null);
  const cellRangeRef = useRef(cellRange);
  cellRangeRef.current = cellRange;
  const cellDragRef = useRef<{ active: boolean; start: CellPos } | null>(null);
  const hoverResetPendingRef = useRef(false);

  useEffect(() => {
    if (loading) {
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
    cellDragRef.current = null;
    dragRef.current = null;
    colResizeRef.current = null;
    wrapRef.current?.classList.remove("db-data-table-wrap--resizing", "db-data-table-wrap--col-resizing");
  }, [effectiveColumns, transposed]);

  useEffect(() => {
    setHiddenColumns((prev) => {
      if (prev.size === 0) return prev;
      const valid = new Set(effectiveColumns);
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
  }, [effectiveColumns]);

  const pkCols = useMemo(() => (columnMeta ?? []).filter((c) => c.isPk), [columnMeta]);

  const buildCellPreviewRowLabel = useCallback(
    (row: Record<string, unknown>, rowIndex: number) =>
      buildTransposeRowHeader(row, rowIndex, page, pageSize, columnMeta),
    [columnMeta, page, pageSize],
  );

  const openCellPreview = useCallback(
    (info: {
      column: string;
      rowIndex: number;
      row: Record<string, unknown>;
      value: unknown;
      columnType?: string;
    }) => {
      setCellPreview({
        column: info.column,
        rowIndex: info.rowIndex,
        rowLabel: buildCellPreviewRowLabel(info.row, info.rowIndex),
        value: info.value,
        columnType: info.columnType,
      });
    },
    [buildCellPreviewRowLabel],
  );
  const filterColumnNames = useMemo(() => getFilterColumnNames(filter), [filter]);
  const canFilter = enableFilter && Boolean(onFilterChange && columnMeta?.length);

  const openFilterPopover = useCallback((anchor: HTMLElement, lockedField: string) => {
    setFilterAnchorRect(anchor.getBoundingClientRect());
    setFilterLockedField(lockedField);
    setFilterOpen(true);
  }, []);

  const canCopyPreviewSql = Boolean(dbType && tableName);

  const visibleColumns = useMemo(
    () => (hiddenColumns.size === 0 ? effectiveColumns : effectiveColumns.filter((c) => !hiddenColumns.has(c))),
    [effectiveColumns, hiddenColumns],
  );

  const previewSql = useMemo(() => {
    if (!canCopyPreviewSql || !dbType || !tableName) return "";
    const allColumnsVisible =
      visibleColumns.length === 0 || visibleColumns.length >= effectiveColumns.length;
    return buildTablePreviewSql({
      dbType,
      tableName,
      filter,
      sort,
      page,
      pageSize,
      selectColumns: allColumnsVisible ? undefined : visibleColumns,
    });
  }, [
    canCopyPreviewSql,
    dbType,
    effectiveColumns.length,
    filter,
    page,
    pageSize,
    sort,
    tableName,
    visibleColumns,
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

  const handleHeaderClick = useCallback(
    (columnId: string) => {
      if (!enableSort || !onSortChange || transposed) return;
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
    [enableSort, onSortChange, sort, transposed],
  );

  const transposedData = useMemo(() => {
    if (!transposed) return null;
    return transposeGridData(visibleColumns, rows, page, pageSize, columnMeta);
  }, [transposed, visibleColumns, rows, page, pageSize, columnMeta]);

  const transposedDirty = useMemo(() => {
    if (!transposed) return null;
    return transposeDirtyState(rows, columnMeta, dirtyRowKeys, cellOverrides);
  }, [transposed, rows, columnMeta, dirtyRowKeys, cellOverrides]);

  const displayColumns = transposed ? transposedData!.columns : visibleColumns;
  const displayRows = transposed ? transposedData!.rows : rows;
  const displayDirtyRowKeys = transposed ? transposedDirty!.dirtyRowKeys : dirtyRowKeys;
  const displayCellOverrides = transposed ? transposedDirty!.cellOverrides : cellOverrides;
  const effectiveOnCellEdit = transposed ? undefined : onCellEdit;
  const transposeRowHeaders = transposedData?.rowHeaders ?? [];

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

  const handleCellEdit = useCallback(
    (info: { rowIndex: number; column: string; row: Record<string, unknown> }) => {
      cellDragRef.current = null;
      effectiveOnCellEdit?.(info);
    },
    [effectiveOnCellEdit],
  );

  const columnDefs = useMemo<ColumnDef<Record<string, unknown>>[]>(
    () => {
      const defs: ColumnDef<Record<string, unknown>>[] = displayColumns.map((col) => {
        const isFieldCol = transposed && col === TRANSPOSE_FIELD_COL;
        const rowHeaderIndex = transposed ? parseInt(col.replace("__row__", ""), 10) : -1;
        const headerLabel = isFieldCol
          ? t("database.results.transposeField")
          : transposed && !Number.isNaN(rowHeaderIndex)
            ? transposeRowHeaders[rowHeaderIndex] ?? col
            : col;
        const headerMeta = !isFieldCol && !transposed ? columnMetaMap?.[col] : undefined;
        return {
          id: col,
          accessorFn: (row) => row[col],
          header: () => (
            <ColumnHeaderLabel
              label={headerLabel}
              meta={headerMeta}
              t={t}
            />
          ),
          cell: ({ getValue, row, column }) => {
            const value = getValue();
            const isRowNumCol = column.id === ROW_NUM_COL_ID;
            const colMetaForCell =
              isFieldCol || isRowNumCol
                ? undefined
                : transposed
                  ? undefined
                  : columnMetaMap?.[column.id];
            const canEditCell = Boolean(effectiveOnCellEdit && colMetaForCell && !isFieldCol && !isRowNumCol);
            return (
              <span
                className="db-data-table-cell-text"
                onDoubleClick={
                  canEditCell
                    ? (event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        handleCellEdit({
                          rowIndex: row.index,
                          column: column.id,
                          row: row.original,
                        });
                      }
                    : undefined
                }
              >
                {cellToText(value)}
              </span>
            );
          },
          minSize: isFieldCol ? 100 : COLUMN_MIN_WIDTH,
          size: isFieldCol ? 140 : 150,
        };
      });
      if (!transposed) {
        defs.unshift({
          id: ROW_NUM_COL_ID,
          accessorFn: () => undefined,
          header: () => <span className="db-row-num-header">#</span>,
          cell: ({ row: r }) => (
            <span className="db-row-num-cell">{page * pageSize + r.index + 1}</span>
          ),
          minSize: 36,
          size: 44,
          enableResizing: false,
          enableSorting: false,
        });
      }
      return defs;
    },
    [displayColumns, transposed, transposeRowHeaders, columnMetaMap, t, page, pageSize, effectiveOnCellEdit, handleCellEdit],
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
    const onMouseMove = (event: MouseEvent) => {
      const wrap = wrapRef.current;
      if (!wrap) return;

      const cellDrag = cellDragRef.current;
      if (cellDrag?.active) {
        const el = document.elementFromPoint(event.clientX, event.clientY);
        const td = el?.closest('td');
        if (!td) return;
        const tr = td.closest('tr');
        if (!tr) return;
        const rowIndex = Number((tr as HTMLElement).dataset.rowIndex);
        const colIndex = Number((td as HTMLElement).dataset.colIndex);
        if (isNaN(rowIndex) || isNaN(colIndex)) return;
        setCellRange({ start: cellDrag.start, end: { row: rowIndex, col: colIndex } });
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

    const endResize = () => {
      const wrap = wrapRef.current;

      if (cellDragRef.current) {
        cellDragRef.current = null;
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
      if (event.key === "Escape" && cellRangeRef.current) {
        setCellRange(null);
        cellDragRef.current = null;
      }
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", endResize);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", endResize);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

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

  const allColumnsHidden = effectiveColumns.length > 0 && visibleColumns.length === 0;
  const tableRows = table.getRowModel().rows;
  const leafColumnCount = table.getAllLeafColumns().length;

  const getRowHeight = useCallback(
    (index: number) => {
      const row = tableRows[index];
      if (!row) return DEFAULT_ROW_HEIGHT;
      return rowHeights[row.index] ?? DEFAULT_ROW_HEIGHT;
    },
    [tableRows, rowHeights],
  );

  const rowVirtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => wrapRef.current,
    estimateSize: getRowHeight,
    overscan: 12,
    getItemKey: (index) => tableRows[index]?.id ?? String(index),
  });

  useLayoutEffect(() => {
    rowVirtualizer.measure();
  }, [rowHeights, tableRows.length]);

  const handleSelectAll = useCallback(() => {
    const maxRow = tableRows.length - 1;
    if (maxRow < 0) return;
    const maxCol = leafColumnCount - 1;
    if (maxCol < 0) return;
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
      setCellRange({
        start: { row: 0, col: colIdx },
        end: { row: maxRow, col: colIdx },
      });
    },
    [leafColumns, tableRows.length],
  );

  if (effectiveColumns.length === 0) {
    return null;
  }

  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const showingFrom = totalRows === 0 ? 0 : page * pageSize + 1;
  const showingTo = Math.min((page + 1) * pageSize, totalRows);

  const virtualRows = rowVirtualizer.getVirtualItems();
  const virtualPaddingTop = virtualRows.length > 0 ? virtualRows[0]!.start : 0;
  const virtualPaddingBottom =
    virtualRows.length > 0
      ? rowVirtualizer.getTotalSize() - virtualRows[virtualRows.length - 1]!.end
      : 0;

  const renderBodyRow = (rowIndex: number) => {
    const row = tableRows[rowIndex];
    if (!row) return null;
    const rowHeight = rowHeights[row.index];
    const isCustomHeight = rowHeight !== undefined;
    const rowKey = transposed
      ? String(row.original[TRANSPOSE_FIELD_COL] ?? "")
      : resolveRowKey(row.original, pkCols);
    const rowDirty = rowKey ? (displayDirtyRowKeys?.has(rowKey) ?? false) : false;
    const overrideForRow = rowKey ? displayCellOverrides?.[rowKey] : undefined;

    return (
      <tr
        key={row.id}
        data-row-index={row.index}
        className={`db-data-table-row${row.index % 2 === 1 ? " db-data-table-row--even" : ""}${isCustomHeight ? " db-data-table-row--custom-h" : ""}${rowDirty ? " db-data-table-row--dirty" : ""}`}
        style={isCustomHeight ? { height: rowHeight } : undefined}
        onMouseDown={(event) => {
          if (!isNearRowBottom(event.currentTarget, event.clientY)) {
            return;
          }
          event.preventDefault();
          beginRowResize(row.index, event.clientY);
        }}
      >
        {row.getVisibleCells().map((cell, cellIdx) => {
          const isRowNum = cell.column.id === ROW_NUM_COL_ID;
          const isFieldCol = transposed && cell.column.id === TRANSPOSE_FIELD_COL;
          const isRowSelector = isRowNum || isFieldCol;
          const colMeta = isRowNum || isFieldCol ? undefined : (transposed ? undefined : columnMetaMap?.[cell.column.id]);
          const canEdit = !isRowSelector && effectiveOnCellEdit && colMeta;
          const overrideValue = isRowSelector ? undefined : overrideForRow?.[cell.column.id];
          const cellDirty = !isRowSelector && overrideValue !== undefined && rowDirty;
          const rawValue = isRowSelector ? undefined : (overrideValue !== undefined ? overrideValue : cell.getValue());
          const baseSize = cell.column.getSize();
          const selected = isCellInRange(row.index, cellIdx, cellRange);
          return (
            <td
              key={cell.id}
              data-col-id={cell.column.id}
              data-col-index={cellIdx}
              style={buildColumnCellStyle(cell.column.id, baseSize, lastColumnId, fillDelta)}
              className={`db-data-table-cell${isCustomHeight ? " db-data-table-cell--custom-h" : ""}${columnSizing[cell.column.id] !== undefined ? " db-data-table-cell--sized" : ""}${canEdit ? " db-cell--editable" : ""}${cellDirty ? " db-data-table-cell--dirty" : ""}${isRowNum ? " db-data-table-cell--rownum" : ""}${isFieldCol ? " db-data-table-cell--field db-data-table-cell--row-select" : ""}${selected ? " db-data-table-cell--selected" : ""}`}
              onMouseDown={
                isRowSelector
                  ? (event) => {
                      if (event.button !== 0) return;
                      const tr = event.currentTarget.closest("tr");
                      if (!tr) return;
                      if (isNearRowBottom(tr, event.clientY)) {
                        event.preventDefault();
                        event.stopPropagation();
                        beginRowResize(row.index, event.clientY);
                        return;
                      }
                      event.preventDefault();
                      event.stopPropagation();
                      const maxCol = leafColumnCount - 1;
                      setCellRange({
                        start: { row: row.index, col: 0 },
                        end: { row: row.index, col: maxCol },
                      });
                    }
                  : (event) => {
                if (event.button !== 0) return;
                if (event.detail >= 2) {
                  cellDragRef.current = null;
                  return;
                }
                if (event.altKey) {
                  event.preventDefault();
                  event.stopPropagation();
                  const previewColumn = transposed
                    ? String(cell.row.original[TRANSPOSE_FIELD_COL] ?? cell.column.id)
                    : cell.column.id;
                  openCellPreview({
                    column: previewColumn,
                    rowIndex: row.index,
                    row: cell.row.original,
                    value: rawValue,
                    columnType: colMeta?.type,
                  });
                  return;
                }
                if (event.shiftKey || event.ctrlKey || event.metaKey) return;
                const tr = event.currentTarget.closest('tr');
                if (!tr) return;
                if (isNearRowBottom(tr, event.clientY)) {
                  event.preventDefault();
                  event.stopPropagation();
                  beginRowResize(row.index, event.clientY);
                  return;
                }
                event.preventDefault();
                event.stopPropagation();
                cellDragRef.current = { active: true, start: { row: row.index, col: cellIdx } };
                setCellRange({ start: { row: row.index, col: cellIdx }, end: { row: row.index, col: cellIdx } });
              }}
              onDoubleClick={
                canEdit
                  ? (event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      handleCellEdit({
                        rowIndex: cell.row.index,
                        column: cell.column.id,
                        row: cell.row.original,
                      });
                    }
                  : undefined
              }
              onContextMenu={
                !isRowSelector && onRowEdit && !transposed
                  ? (event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      cellMenuOpenRef.current({
                        x: event.clientX,
                        y: event.clientY,
                        rowIndex: cell.row.index,
                        column: cell.column.id,
                        row: cell.row.original,
                      });
                    }
                  : undefined
              }
              title={!isRowSelector ? cellToText(rawValue) : undefined}
            >
              {flexRender(cell.column.columnDef.cell, cell.getContext())}
            </td>
          );
        })}
      </tr>
    );
  };

  return (
    <div className="db-data-table-panel">
    {allColumnsHidden ? (
      <div className="db-data-table-all-hidden">
        {t("database.results.columnVisibilityAllHidden")}
      </div>
    ) : (
    <div
      ref={wrapRef}
      className={`db-data-table-wrap db-data-table-wrap--virtual${transposed ? " db-data-table-wrap--transposed" : ""}${loading ? " db-data-table-wrap--loading" : ""}`}
    >
      <table
        className="db-data-table"
        style={{ width: fillDelta > 0 ? "100%" : totalTableWidth, minWidth: "100%" }}
      >
        <colgroup>
          {leafColumns.map((column) => (
            <col
              key={column.id}
              data-col-id={column.id}
              style={{ width: resolveColumnWidth(column.id, column.getSize()) }}
            />
          ))}
        </colgroup>
        <thead>
                {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header, headerColIdx) => {
                const baseSize = header.getSize();
                const colId = header.column.id;
                const isFieldCol = transposed && colId === TRANSPOSE_FIELD_COL;
                const isSelectAllHeader = colId === ROW_NUM_COL_ID || isFieldCol;
                const canSort = enableSort && !isFieldCol && colId !== ROW_NUM_COL_ID;
                const sortActive = canSort && sort?.column === colId;
                const sortDirection = sortActive ? sort!.direction : null;
                const sortClass = sortActive
                  ? sortDirection === "asc"
                    ? " db-data-table-th--sort-asc"
                    : " db-data-table-th--sort-desc"
                  : "";
                const filterClass =
                  canFilter && filterColumnNames.has(colId) ? " db-data-table-th--filtered" : "";
                const thSelected = isHeaderInColumnSelection(headerColIdx, cellRange, tableRows.length);
                const colMeta = !transposed && !isFieldCol && colId !== ROW_NUM_COL_ID
                  ? columnMetaMap?.[colId]
                  : undefined;
                const headerTitle = isSelectAllHeader
                  ? t("database.results.selectAll")
                  : colMeta
                    ? buildColumnHeaderTooltip(colMeta, colId, t)
                    : colId !== ROW_NUM_COL_ID
                      ? colId
                      : undefined;
                return (
                <th
                  key={header.id}
                  data-col-id={colId}
                  style={buildColumnCellStyle(colId, baseSize, lastColumnId, fillDelta)}
                  className={`${table.getState().columnSizingInfo?.isResizingColumn === colId ? "db-data-table-th-resizing" : ""}${canSort ? " db-data-table-th--sortable" : ""}${isSelectAllHeader || colId !== ROW_NUM_COL_ID ? " db-data-table-th--selectable" : ""}${isSelectAllHeader ? " db-data-table-th--select-all" : ""}${thSelected ? " db-data-table-th--selected" : ""}${sortClass}${filterClass}`}
                  onClick={
                    isSelectAllHeader
                      ? handleSelectAll
                      : () => handleColumnSelect(colId)
                  }
                  title={headerTitle}
                >
                  {header.isPlaceholder ? null : (
                    <span className="db-data-table-th-inner">
                      <span className="db-data-table-th-label">
                        {flexRender(header.column.columnDef.header, header.getContext())}
                      </span>
                      {canSort && (
                        <span
                          className={`db-data-table-sort-indicator${sortActive ? " db-data-table-sort-indicator--active" : ""}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleHeaderClick(colId);
                          }}
                          title={t("database.results.sortHint")}
                        >
                          {sortDirection === "asc" ? (
                            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" width="10" height="10">
                              <path d="M8 12V4M4 8l4-4 4 4" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          ) : sortDirection === "desc" ? (
                            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" width="10" height="10">
                              <path d="M8 4v8M4 8l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          ) : (
                            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" width="10" height="10">
                              <path d="M8 13V3M4.5 6.5L8 3l3.5 3.5" strokeLinecap="round" strokeLinejoin="round" />
                              <path d="M4.5 9.5L8 13l3.5-3.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.5" />
                            </svg>
                          )}
                        </span>
                      )}
                      {canFilter && colId !== ROW_NUM_COL_ID && !isFieldCol && (
                        <button
                          type="button"
                          className={`db-data-table-filter-btn${filterColumnNames.has(colId) ? " db-data-table-filter-btn--active" : ""}`}
                          title={t("database.results.filterColumnHint")}
                          aria-label={t("database.results.filterColumnHint")}
                          onClick={(event) => {
                            event.stopPropagation();
                            openFilterPopover(event.currentTarget, colId);
                          }}
                        >
                          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" width="10" height="10" aria-hidden>
                            <path d="M2 3h12M4.5 8h7M7 13h2" strokeLinecap="round" />
                          </svg>
                        </button>
                      )}
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
        <tbody>
          {virtualPaddingTop > 0 && (
            <tr className="db-data-table-spacer-row" aria-hidden>
              <td colSpan={leafColumnCount} style={{ height: virtualPaddingTop }} />
            </tr>
          )}
          {virtualRows.map((virtualRow) => renderBodyRow(virtualRow.index))}
          {virtualPaddingBottom > 0 && (
            <tr className="db-data-table-spacer-row" aria-hidden>
              <td colSpan={leafColumnCount} style={{ height: virtualPaddingBottom }} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
    )}
    {onRowEdit && !allColumnsHidden && (
      <TableCellContextMenu
        menuOpenRef={cellMenuOpenRef}
        onRowEdit={onRowEdit!}
        onCellSetNull={onCellSetNull}
        columnMeta={columnMeta}
        cellOverrides={displayCellOverrides}
      />
    )}
    <div className="db-pagination">
      <div className="db-pagination-left">
        {toolbar ? <div className="db-pagination-toolbar">{toolbar}</div> : null}
        <div className="db-pagination-info">
        {effectiveColumns.length > 0 && (
          <Button
            ref={colVisAnchorRef}
            variant={colVisOpen ? "default" : "ghost"}
            size="sm"
            className="db-col-visibility-toggle"
            title={t("database.results.columnVisibilityTitle")}
            aria-label={t("database.results.columnVisibility")}
            aria-haspopup="dialog"
            aria-expanded={colVisOpen}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => setColVisOpen((prev) => !prev)}
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
              <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
              <path d="M5 2.5v11M9.5 2.5v11" />
            </svg>
          </Button>
        )}
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
        {loading ? (
          <span>{t("common.loading")}</span>
        ) : totalRows > 0 ? (
          <span>
            {showingFrom.toLocaleString()}–{showingTo.toLocaleString()} of{" "}
            {totalRows.toLocaleString()} rows
          </span>
        ) : (
          <span>0 rows</span>
        )}
        </div>
      </div>
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
    {colVisOpen && colVisAnchorRef.current && (
      <ColumnVisibilityPopover
        anchorRect={colVisAnchorRef.current.getBoundingClientRect()}
        columns={effectiveColumns}
        hiddenColumns={hiddenColumns}
        onChange={setHiddenColumns}
        onClose={() => setColVisOpen(false)}
      />
    )}
    {filterOpen && filterAnchorRect && filterLockedField && columnMeta && onFilterChange && (
      <TableDataGridFilterPopover
        anchorRect={filterAnchorRect}
        columnMeta={columnMeta}
        initialQuery={filter}
        lockedField={filterLockedField}
        onApply={onFilterChange}
        onClose={() => setFilterOpen(false)}
      />
    )}
    <TableDataGridCellPreviewDrawer
      preview={cellPreview}
      onClose={() => setCellPreview(null)}
    />
    </div>
  );
});
