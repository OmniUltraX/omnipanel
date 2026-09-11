import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import {
  PanelGridCanvasBody,
  type PanelGridColumnSpec,
} from "../../../components/ui/canvas-grid";
import {
  useResizableTableColumns,
  type ResizableColumnDef,
} from "../../../components/ui/table/useResizableTableColumns";
import { useI18n } from "../../../i18n";
import { showToast } from "../../../stores/toastStore";

export type DbTablesPanelGridSortDirection = "asc" | "desc";

export type DbTablesPanelGridVariant = "default" | "processlist" | "variables";

export type DbTablesPanelGridColumnVariant = "default" | "actions" | "actionsSticky";

export interface DbTablesPanelGridColumn<T> {
  id: string;
  header: ReactNode;
  /** 排序状态 id；默认同 id */
  sortId?: string;
  sortable?: boolean;
  /** 首列等宽 mono 样式 */
  nameCell?: boolean;
  variant?: DbTablesPanelGridColumnVariant;
  /** 是否支持选中与复制；操作列默认 false */
  copyable?: boolean;
  /** 启用列宽拖拽时的默认宽度（px） */
  defaultWidth?: number;
  /** 列宽最小值（px） */
  minWidth?: number;
  /** 是否可拖拽列宽；默认非操作列可拖，操作列不可 */
  resizable?: boolean;
  headerAriaLabel?: string;
  headerClassName?: string;
  cellClassName?: string;
  render: (row: T, rowIndex: number) => ReactNode;
  getTitle?: (row: T) => string | undefined;
  /** 复制到剪贴板的文本；默认使用 getTitle */
  getCopyValue?: (row: T) => string | undefined;
}

export interface DbTablesPanelGridProps<T> {
  columns: DbTablesPanelGridColumn<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string | number;
  variant?: DbTablesPanelGridVariant;
  className?: string;
  sortColumnId?: string | null;
  sortDirection?: DbTablesPanelGridSortDirection;
  onSortColumn?: (sortId: string) => void;
  /** 单选（兼容旧用法）；与 selectedRowKeys 同时存在时以 selectedRowKeys 为准 */
  selectedRowKey?: string | number | null;
  /** 多选行 key 集合 */
  selectedRowKeys?: ReadonlySet<string | number>;
  onRowClick?: (row: T, event: ReactMouseEvent) => void;
  onRowDoubleClick?: (row: T, event: ReactMouseEvent) => void;
  onRowContextMenu?: (row: T, event: ReactMouseEvent) => void;
  rowClassName?: (row: T) => string | undefined;
  /** 传入后启用列宽拖拽，并持久化到 localStorage */
  columnResizeStorageKey?: string;
  /**
   * @deprecated 面板网格已固定 Canvas 渲染；保留 prop 以免破坏调用方。
   */
  virtualizeRows?: boolean;
  /** Canvas 行高 */
  virtualRowHeight?: number;
  /** Ctrl/Cmd+A 全选 */
  onSelectAllRows?: () => void;
  /** Escape 清除选区 */
  onClearSelection?: () => void;
  /** Ctrl/Cmd+C：复制选中行（由外层决定语义，如克隆用） */
  onCopySelectedRows?: () => void;
  /** Ctrl/Cmd+V：粘贴/克隆 */
  onPasteRows?: () => void;
  /** Delete / Backspace */
  onDeleteSelectedRows?: () => void;
  /** Enter：打开当前选中行（单选时） */
  onActivateSelectedRows?: () => void;
}

interface CellSelection {
  rowKey: string | number;
  columnId: string;
}

const DEFAULT_VIRTUAL_ROW_HEIGHT = 29;

function isActionColumn(column: DbTablesPanelGridColumn<unknown>): boolean {
  return column.variant === "actions" || column.variant === "actionsSticky";
}

function isColumnCopyable<T>(column: DbTablesPanelGridColumn<T>): boolean {
  if (column.copyable != null) {
    return column.copyable;
  }
  return !isActionColumn(column as DbTablesPanelGridColumn<unknown>);
}

async function writeToClipboard(text: string): Promise<boolean> {
  const clip = navigator.clipboard;
  if (clip && typeof clip.writeText === "function") {
    try {
      await clip.writeText(text);
      return true;
    } catch {
      // fallback below
    }
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}

function resolveSortHeaderClass(
  columnSortId: string,
  activeSortColumnId: string | null | undefined,
  direction: DbTablesPanelGridSortDirection,
): string {
  if (activeSortColumnId !== columnSortId) {
    return "db-tables-panel-grid__sortable";
  }
  return direction === "asc"
    ? "db-tables-panel-grid__sortable db-tables-panel-grid__sort-asc"
    : "db-tables-panel-grid__sortable db-tables-panel-grid__sort-desc";
}

function headerCellClassName(
  column: DbTablesPanelGridColumn<unknown>,
  sortColumnId: string | null | undefined,
  sortDirection: DbTablesPanelGridSortDirection,
): string {
  const sortId = column.sortId ?? column.id;
  const classes: string[] = [];

  if (column.nameCell) {
    classes.push("db-tables-panel-grid__name-col");
  }
  if (column.sortable) {
    classes.push(resolveSortHeaderClass(sortId, sortColumnId, sortDirection));
  }
  if (column.variant === "actions") {
    classes.push("db-tables-panel-grid__actions-col");
  }
  if (column.variant === "actionsSticky") {
    classes.push("db-tables-panel-grid__actions-col", "db-tables-panel-grid__actions-col--sticky");
  }
  if (column.headerClassName) {
    classes.push(column.headerClassName);
  }

  return classes.filter(Boolean).join(" ");
}

function toResizeColumnDefs<T>(columns: DbTablesPanelGridColumn<T>[]): ResizableColumnDef[] {
  return columns.map((column) => ({
    id: column.id,
    defaultWidth: column.defaultWidth ?? (column.nameCell ? 180 : 120),
    minWidth: column.minWidth ?? 48,
    resizable: column.resizable ?? !isActionColumn(column as DbTablesPanelGridColumn<unknown>),
  }));
}

function tableClassName(
  variant: DbTablesPanelGridVariant,
  className: string | undefined,
  resizable: boolean,
): string {
  const classes = ["db-tables-panel-grid"];
  if (variant !== "default") {
    classes.push(`db-tables-panel-grid--${variant}`);
  }
  if (resizable) {
    classes.push("db-tables-panel-grid--resizable");
  }
  if (className) {
    classes.push(className);
  }
  return classes.join(" ");
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.isContentEditable ||
    Boolean(target.closest("input, textarea, [contenteditable='true']"))
  );
}

function resolveDisplayText<T>(
  column: DbTablesPanelGridColumn<T>,
  row: T,
  rowIndex: number,
): string {
  if (isActionColumn(column as DbTablesPanelGridColumn<unknown>)) {
    return "";
  }
  const fromCopy = column.getCopyValue?.(row);
  if (fromCopy != null && fromCopy !== "") return fromCopy;
  const fromTitle = column.getTitle?.(row);
  if (fromTitle != null && fromTitle !== "") return fromTitle;
  const node = column.render(row, rowIndex);
  if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
    return String(node);
  }
  return "";
}

function defaultColumnWidth<T>(column: DbTablesPanelGridColumn<T>): number {
  if (isActionColumn(column as DbTablesPanelGridColumn<unknown>)) return 36;
  return column.defaultWidth ?? (column.nameCell ? 180 : 120);
}

/** 数据库侧栏/连接信息面板共用的对齐表格（固定 Canvas body）。 */
export function DbTablesPanelGrid<T>({
  columns,
  rows,
  rowKey,
  variant = "default",
  className,
  sortColumnId = null,
  sortDirection = "asc",
  onSortColumn,
  selectedRowKey = null,
  selectedRowKeys,
  onRowClick,
  onRowDoubleClick,
  onRowContextMenu,
  rowClassName: _rowClassName,
  columnResizeStorageKey,
  virtualRowHeight = DEFAULT_VIRTUAL_ROW_HEIGHT,
  onSelectAllRows,
  onClearSelection,
  onCopySelectedRows,
  onPasteRows,
  onDeleteSelectedRows,
  onActivateSelectedRows,
}: DbTablesPanelGridProps<T>) {
  const { t } = useI18n();
  const hostRef = useRef<HTMLDivElement>(null);
  const [selectedCell, setSelectedCell] = useState<CellSelection | null>(null);
  const [hostWidth, setHostWidth] = useState(0);
  const resizeEnabled = Boolean(columnResizeStorageKey);

  const resizeColumnDefs = useMemo(
    () => (resizeEnabled ? toResizeColumnDefs(columns) : []),
    [columns, resizeEnabled],
  );

  const {
    tableRef,
    columnWidths,
    resizingColumnId,
    startColumnResize,
    isColumnResizable,
  } = useResizableTableColumns(resizeColumnDefs, {
    storageKey: columnResizeStorageKey,
    constrainMaxWidth: false,
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const update = () => setHostWidth(host.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  const canvasColumns = useMemo((): PanelGridColumnSpec[] => {
    const base = columns.map((column) => {
      const width = resizeEnabled
        ? (columnWidths[column.id] ?? defaultColumnWidth(column))
        : defaultColumnWidth(column);
      return {
        id: column.id,
        width,
        pinned: false,
        mono: Boolean(column.nameCell),
        copyable: isColumnCopyable(column),
      };
    });
    if (hostWidth <= 0) return base;
    const total = base.reduce((sum, col) => sum + col.width, 0);
    if (hostWidth <= total) return base;
    const stretch = hostWidth - total;
    // 优先扩展名称列，其次第一个非操作列
    let target = base.findIndex((col) => {
      const column = columns.find((c) => c.id === col.id);
      return Boolean(column?.nameCell);
    });
    if (target < 0) {
      target = base.findIndex((col) => {
        const column = columns.find((c) => c.id === col.id);
        return column != null && !isActionColumn(column as DbTablesPanelGridColumn<unknown>);
      });
    }
    if (target < 0) return base;
    return base.map((col, index) =>
      index === target ? { ...col, width: col.width + stretch } : col,
    );
  }, [columnWidths, columns, hostWidth, resizeEnabled]);

  const canvasContentWidth = useMemo(
    () => canvasColumns.reduce((total, col) => total + col.width, 0),
    [canvasColumns],
  );

  const selectedCellForCanvas = useMemo(() => {
    if (!selectedCell) return null;
    const rowIndex = rows.findIndex(
      (row, index) => rowKey(row, index) === selectedCell.rowKey,
    );
    if (rowIndex < 0) return null;
    return { rowIndex, columnId: selectedCell.columnId };
  }, [rowKey, rows, selectedCell]);

  const getCanvasCellText = useCallback(
    (row: T, columnId: string, rowIndex: number) => {
      const column = columns.find((col) => col.id === columnId);
      if (!column) return "";
      return resolveDisplayText(column, row, rowIndex);
    },
    [columns],
  );

  const isRowSelected = useCallback(
    (key: string | number) => {
      if (selectedRowKeys) {
        return selectedRowKeys.has(key);
      }
      return selectedRowKey != null && selectedRowKey === key;
    },
    [selectedRowKey, selectedRowKeys],
  );

  const isCanvasRowSelected = useCallback(
    (row: T, rowIndex: number) => isRowSelected(rowKey(row, rowIndex)),
    [isRowSelected, rowKey],
  );

  const resolveCopyText = useCallback(
    (row: T, column: DbTablesPanelGridColumn<T>): string => {
      const fromGetter = column.getCopyValue?.(row) ?? column.getTitle?.(row);
      if (fromGetter != null && fromGetter !== "") {
        return fromGetter;
      }
      return "";
    },
    [],
  );

  const copySelectedCell = useCallback(() => {
    if (!selectedCell) {
      return false;
    }
    const rowIndex = rows.findIndex((row, index) => rowKey(row, index) === selectedCell.rowKey);
    if (rowIndex < 0) {
      return false;
    }
    const row = rows[rowIndex];
    const column = columns.find((col) => col.id === selectedCell.columnId);
    if (!row || !column || !isColumnCopyable(column)) {
      return false;
    }
    const text = resolveCopyText(row, column);
    if (!text) {
      return false;
    }
    void writeToClipboard(text).then((ok) => {
      if (ok) showToast(t("common.copied"));
    });
    return true;
  }, [columns, resolveCopyText, rowKey, rows, selectedCell, t]);

  useEffect(() => {
    if (!selectedCell) {
      return;
    }
    const stillExists = rows.some(
      (row, index) => rowKey(row, index) === selectedCell.rowKey,
    );
    if (!stillExists) {
      setSelectedCell(null);
    }
  }, [rowKey, rows, selectedCell]);

  const handleHostKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (isEditableTarget(event.target)) return;
      const mod = event.ctrlKey || event.metaKey;

      if (event.key === "Escape") {
        onClearSelection?.();
        setSelectedCell(null);
        return;
      }

      if (event.key === "Enter" && onActivateSelectedRows) {
        event.preventDefault();
        onActivateSelectedRows();
        return;
      }

      if (mod && event.key.toLowerCase() === "a" && onSelectAllRows) {
        event.preventDefault();
        onSelectAllRows();
        return;
      }

      if (mod && event.key.toLowerCase() === "c") {
        if (onCopySelectedRows && selectedRowKeys && selectedRowKeys.size > 0) {
          event.preventDefault();
          onCopySelectedRows();
          return;
        }
        if (copySelectedCell()) {
          event.preventDefault();
        }
        return;
      }

      if (mod && event.key.toLowerCase() === "v" && onPasteRows) {
        event.preventDefault();
        onPasteRows();
        return;
      }

      if (
        (event.key === "Delete" || event.key === "Backspace") &&
        onDeleteSelectedRows &&
        selectedRowKeys &&
        selectedRowKeys.size > 0
      ) {
        event.preventDefault();
        onDeleteSelectedRows();
      }
    },
    [
      copySelectedCell,
      onActivateSelectedRows,
      onClearSelection,
      onCopySelectedRows,
      onDeleteSelectedRows,
      onPasteRows,
      onSelectAllRows,
      selectedRowKeys,
    ],
  );

  return (
    <div
      ref={hostRef}
      className={[
        "db-tables-panel-grid-host",
        // --virtual 提供 overflow:auto（与历史 CSS 约定一致）；--canvas 挂 sticky 表头与 canvas body
        "db-tables-panel-grid-host--virtual",
        "db-tables-panel-grid-host--canvas",
        resizeEnabled && resizingColumnId ? "db-tables-panel-grid-host--col-resizing" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={
        {
          ["--panel-grid-content-width" as string]: `${Math.max(canvasContentWidth, 1)}px`,
        } as CSSProperties
      }
      tabIndex={0}
      onKeyDown={handleHostKeyDown}
    >
      <table
        ref={tableRef}
        className={[
          tableClassName(variant, className, resizeEnabled),
          "db-tables-panel-grid--canvas-chrome",
        ]
          .filter(Boolean)
          .join(" ")}
        style={{
          width: Math.max(canvasContentWidth, 1),
          minWidth: "100%",
          tableLayout: "fixed",
        }}
      >
        <colgroup>
          {canvasColumns.map((column) => (
            <col
              key={column.id}
              data-col-id={column.id}
              style={{ width: column.width }}
            />
          ))}
        </colgroup>
        <thead>
          <tr>
            {columns.map((column) => {
              const sortId = column.sortId ?? column.id;
              const sortable = column.sortable && onSortColumn != null;
              const canResize = resizeEnabled && isColumnResizable(column.id);
              const canvasCol = canvasColumns.find((c) => c.id === column.id);
              return (
                <th
                  key={column.id}
                  data-col-id={column.id}
                  className={[
                    headerCellClassName(
                      column as DbTablesPanelGridColumn<unknown>,
                      sortColumnId,
                      sortDirection,
                    ),
                    resizeEnabled && resizingColumnId === column.id
                      ? "db-tables-panel-grid__th--resizing"
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  style={
                    canvasCol
                      ? { width: canvasCol.width, minWidth: canvasCol.width }
                      : undefined
                  }
                  onClick={sortable ? () => onSortColumn(sortId) : undefined}
                  aria-sort={
                    sortable && sortColumnId === sortId
                      ? sortDirection === "asc"
                        ? "ascending"
                        : "descending"
                      : "none"
                  }
                  aria-label={column.headerAriaLabel}
                >
                  {sortable ? (
                    <span className="db-tables-panel-grid__th-label">
                      {column.header}
                      {sortColumnId === sortId ? (
                        <span className="db-tables-panel-grid__sort-mark" aria-hidden>
                          {sortDirection === "asc" ? "↑" : "↓"}
                        </span>
                      ) : null}
                    </span>
                  ) : (
                    column.header
                  )}
                  {canResize ? (
                    <div
                      className="db-tables-panel-grid__col-resize"
                      onMouseDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        startColumnResize(column.id, event.clientX);
                      }}
                      onClick={(event) => event.stopPropagation()}
                    />
                  ) : null}
                </th>
              );
            })}
          </tr>
        </thead>
      </table>
      <PanelGridCanvasBody
        scrollElementRef={hostRef}
        columns={canvasColumns}
        rows={rows}
        rowHeight={virtualRowHeight}
        getCellText={getCanvasCellText}
        isRowSelected={isCanvasRowSelected}
        selectedCell={selectedCellForCanvas}
        drawStyle="list"
        sizerClassName="db-tables-panel-grid-canvas-sizer"
        canvasClassName="db-tables-panel-grid-canvas"
        onCellClick={(row, rowIndex, columnId, event) => {
          const key = rowKey(row, rowIndex);
          setSelectedCell({ rowKey: key, columnId });
          onRowClick?.(row, event);
        }}
        onRowClick={(row, _rowIndex, event) => {
          onRowClick?.(row, event);
        }}
        onRowDoubleClick={(row, rowIndex, columnId, event) => {
          if (onRowDoubleClick) {
            onRowDoubleClick(row, event);
            return;
          }
          const column = columns.find((col) => col.id === columnId);
          if (!column || !isColumnCopyable(column)) return;
          const text = resolveCopyText(row, column);
          if (!text) return;
          void writeToClipboard(text).then((ok) => {
            if (ok) showToast(t("common.copied"));
          });
          setSelectedCell({ rowKey: rowKey(row, rowIndex), columnId });
        }}
        onRowContextMenu={(row, _rowIndex, event) => {
          if (!onRowContextMenu) return;
          event.preventDefault();
          onRowContextMenu(row, event);
        }}
      />
    </div>
  );
}
