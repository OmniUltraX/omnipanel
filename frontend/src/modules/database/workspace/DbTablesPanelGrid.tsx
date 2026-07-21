import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

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
  /** 启用行虚拟滚动（大量行时） */
  virtualizeRows?: boolean;
  /** 虚拟行估算高度 */
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
const VIRTUALIZE_THRESHOLD = 80;

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

function bodyCellClassName(
  column: DbTablesPanelGridColumn<unknown>,
  selected: boolean,
  copyable: boolean,
): string | undefined {
  const classes: string[] = [];
  if (column.nameCell) {
    classes.push("db-tables-panel-grid__name");
  }
  if (column.variant === "actions") {
    classes.push("db-tables-panel-grid__actions-col");
  }
  if (column.variant === "actionsSticky") {
    classes.push("db-tables-panel-grid__actions-col", "db-tables-panel-grid__actions-col--sticky");
  }
  if (column.cellClassName) {
    classes.push(column.cellClassName);
  }
  if (copyable) {
    classes.push("db-tables-panel-grid__cell-copyable");
  }
  if (selected) {
    classes.push("db-tables-panel-grid__cell--selected");
  }
  return classes.length > 0 ? classes.join(" ") : undefined;
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

/** 数据库侧栏/连接信息面板共用的对齐表格。 */
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
  rowClassName,
  columnResizeStorageKey,
  virtualizeRows,
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
  const resizeEnabled = Boolean(columnResizeStorageKey);
  const useVirtual =
    virtualizeRows === true || (virtualizeRows !== false && rows.length >= VIRTUALIZE_THRESHOLD);

  const resizeColumnDefs = useMemo(
    () => (resizeEnabled ? toResizeColumnDefs(columns) : []),
    [columns, resizeEnabled],
  );

  const {
    tableRef,
    columnWidths,
    resizingColumnId,
    getColumnStyle,
    startColumnResize,
    isColumnResizable,
  } = useResizableTableColumns(resizeColumnDefs, {
    storageKey: columnResizeStorageKey,
    constrainMaxWidth: false,
  });

  const tableMinWidth = useMemo(() => {
    if (!resizeEnabled || resizeColumnDefs.length === 0) {
      return undefined;
    }
    const sum = resizeColumnDefs.reduce(
      (total, column) => total + (columnWidths[column.id] ?? column.defaultWidth),
      0,
    );
    return `max(100%, ${sum}px)`;
  }, [columnWidths, resizeColumnDefs, resizeEnabled]);

  const rowVirtualizer = useVirtualizer({
    count: useVirtual ? rows.length : 0,
    getScrollElement: () => hostRef.current,
    estimateSize: () => virtualRowHeight,
    // 快速滚动缓冲：上下各多渲约 40 行，避免出现空白带
    overscan: 40,
    // 避免在 React commit/layout 期间 flushSync（Docker 等模块状态更新会连带重渲表格）
    useFlushSync: false,
  });

  const virtualItems = useVirtual ? rowVirtualizer.getVirtualItems() : null;
  const paddingTop = virtualItems && virtualItems.length > 0 ? virtualItems[0]!.start : 0;
  const paddingBottom =
    virtualItems && virtualItems.length > 0
      ? rowVirtualizer.getTotalSize() - virtualItems[virtualItems.length - 1]!.end
      : 0;

  const isRowSelected = useCallback(
    (key: string | number) => {
      if (selectedRowKeys) {
        return selectedRowKeys.has(key);
      }
      return selectedRowKey != null && selectedRowKey === key;
    },
    [selectedRowKey, selectedRowKeys],
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

  const colSpan = columns.length;

  const renderRow = (row: T, rowIndex: number) => {
    const key = rowKey(row, rowIndex);
    const selected = isRowSelected(key);
    const extraClass = rowClassName?.(row);
    return (
      <tr
        key={key}
        data-row-key={String(key)}
        className={[selected ? "is-selected" : "", extraClass ?? ""].filter(Boolean).join(" ") || undefined}
        onClick={(event) => onRowClick?.(row, event)}
        onDoubleClick={(event) => onRowDoubleClick?.(row, event)}
        onContextMenu={(event) => {
          if (!onRowContextMenu) return;
          event.preventDefault();
          onRowContextMenu(row, event);
        }}
      >
        {columns.map((column) => {
          const title = column.getTitle?.(row);
          const copyable = isColumnCopyable(column);
          const cellSelected =
            selectedCell?.rowKey === key && selectedCell.columnId === column.id;
          const cellClass = bodyCellClassName(
            column as DbTablesPanelGridColumn<unknown>,
            cellSelected,
            copyable,
          );
          return (
            <td
              key={column.id}
              data-col-id={column.id}
              className={cellClass || undefined}
              style={resizeEnabled ? getColumnStyle(column.id) : undefined}
              title={title}
              onClick={(event) => {
                if (!copyable) {
                  return;
                }
                event.stopPropagation();
                setSelectedCell({ rowKey: key, columnId: column.id });
                onRowClick?.(row, event);
              }}
              onDoubleClick={(event) => {
                if (onRowDoubleClick) {
                  // 行双击优先（打开表数据等），单元格双击复制让位于行级
                  return;
                }
                if (!copyable) {
                  return;
                }
                event.stopPropagation();
                const text = resolveCopyText(row, column);
                if (text) {
                  void writeToClipboard(text).then((ok) => {
                    if (ok) {
                      showToast(t("common.copied"));
                    }
                  });
                }
              }}
              onContextMenu={(event) => {
                if (!onRowContextMenu) return;
                event.preventDefault();
                event.stopPropagation();
                onRowContextMenu(row, event);
              }}
            >
              {column.render(row, rowIndex)}
            </td>
          );
        })}
      </tr>
    );
  };

  return (
    <div
      ref={hostRef}
      className={[
        "db-tables-panel-grid-host",
        useVirtual ? "db-tables-panel-grid-host--virtual" : "",
        resizeEnabled && resizingColumnId ? "db-tables-panel-grid-host--col-resizing" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      tabIndex={0}
      onKeyDown={handleHostKeyDown}
    >
      <table
        ref={tableRef}
        className={tableClassName(variant, className, resizeEnabled)}
        style={tableMinWidth != null ? { minWidth: tableMinWidth } : undefined}
      >
        {resizeEnabled ? (
          <colgroup>
            {columns.map((column) => (
              <col key={column.id} data-col-id={column.id} style={getColumnStyle(column.id)} />
            ))}
          </colgroup>
        ) : null}
        <thead>
          <tr>
            {columns.map((column) => {
              const sortId = column.sortId ?? column.id;
              const sortable = column.sortable && onSortColumn != null;
              const canResize = resizeEnabled && isColumnResizable(column.id);
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
                  style={resizeEnabled ? getColumnStyle(column.id) : undefined}
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
        <tbody>
          {useVirtual && virtualItems ? (
            <>
              {paddingTop > 0 ? (
                <tr className="db-tables-panel-grid__spacer" aria-hidden>
                  <td colSpan={colSpan} style={{ height: paddingTop, padding: 0, border: "none" }} />
                </tr>
              ) : null}
              {virtualItems.map((virtualRow) => {
                const row = rows[virtualRow.index];
                if (row == null) return null;
                return renderRow(row, virtualRow.index);
              })}
              {paddingBottom > 0 ? (
                <tr className="db-tables-panel-grid__spacer" aria-hidden>
                  <td
                    colSpan={colSpan}
                    style={{ height: paddingBottom, padding: 0, border: "none" }}
                  />
                </tr>
              ) : null}
            </>
          ) : (
            rows.map((row, rowIndex) => renderRow(row, rowIndex))
          )}
        </tbody>
      </table>
    </div>
  );
}
