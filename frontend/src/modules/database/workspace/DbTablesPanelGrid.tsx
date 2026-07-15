import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

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
  /** 列宽下限（px） */
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
  selectedRowKey?: string | number | null;
  onRowClick?: (row: T) => void;
  rowClassName?: (row: T) => string | undefined;
  /** 传入后启用列宽拖拽，并持久化到 localStorage */
  columnResizeStorageKey?: string;
}

interface CellSelection {
  rowKey: string | number;
  columnId: string;
}

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
  if (copyable) {
    classes.push("db-tables-panel-grid__cell-copyable");
  }
  if (selected) {
    classes.push("db-tables-panel-grid__cell--selected");
  }
  if (column.cellClassName) {
    classes.push(column.cellClassName);
  }
  return classes.length > 0 ? classes.join(" ") : undefined;
}

function defaultWidthForColumn(column: DbTablesPanelGridColumn<unknown>): number {
  if (column.defaultWidth != null) {
    return column.defaultWidth;
  }
  if (column.variant === "actionsSticky") {
    return 140;
  }
  if (column.variant === "actions") {
    return 48;
  }
  if (column.nameCell) {
    return 160;
  }
  return 120;
}

function toResizeColumnDefs<T>(columns: DbTablesPanelGridColumn<T>[]): ResizableColumnDef[] {
  return columns.map((column) => {
    const action = isActionColumn(column as DbTablesPanelGridColumn<unknown>);
    return {
      id: column.id,
      defaultWidth: defaultWidthForColumn(column as DbTablesPanelGridColumn<unknown>),
      minWidth: column.minWidth ?? (action ? 48 : 64),
      resizable: column.resizable ?? !action,
    };
  });
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
  onRowClick,
  rowClassName,
  columnResizeStorageKey,
}: DbTablesPanelGridProps<T>) {
  const { t } = useI18n();
  const hostRef = useRef<HTMLDivElement>(null);
  const [selectedCell, setSelectedCell] = useState<CellSelection | null>(null);
  const resizeEnabled = Boolean(columnResizeStorageKey);

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
    // 不锁 maxWidth，table-layout:fixed + width:100% 时余量可分给各列以撑满父级
    constrainMaxWidth: false,
  });

  const tableMinWidth = useMemo(() => {
    if (!resizeEnabled || resizeColumnDefs.length === 0) {
      return undefined;
    }
    // 列宽之和；CSS 另有 min-width:100%，二者取较大者，窄于父级时仍撑满
    return resizeColumnDefs.reduce(
      (sum, column) => sum + (columnWidths[column.id] ?? column.defaultWidth),
      0,
    );
  }, [columnWidths, resizeColumnDefs, resizeEnabled]);

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
      return;
    }
    const rowIndex = rows.findIndex((row, index) => rowKey(row, index) === selectedCell.rowKey);
    if (rowIndex < 0) {
      return;
    }
    const row = rows[rowIndex];
    const column = columns.find((col) => col.id === selectedCell.columnId);
    if (!row || !column || !isColumnCopyable(column)) {
      return;
    }
    const text = resolveCopyText(row, column);
    if (text) {
      void writeToClipboard(text);
    }
  }, [columns, resolveCopyText, rowKey, rows, selectedCell]);

  useEffect(() => {
    if (!selectedCell) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "c") {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      copySelectedCell();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [copySelectedCell, selectedCell]);

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

  return (
    <div
      ref={hostRef}
      className={[
        "db-tables-panel-grid-host",
        resizeEnabled && resizingColumnId ? "db-tables-panel-grid-host--col-resizing" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      tabIndex={-1}
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
          {rows.map((row, rowIndex) => {
            const key = rowKey(row, rowIndex);
            const selected = selectedRowKey != null && selectedRowKey === key;
            const extraClass = rowClassName?.(row);
            return (
              <tr
                key={key}
                className={[selected ? "is-selected" : "", extraClass ?? ""].filter(Boolean).join(" ") || undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
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
                        onRowClick?.(row);
                      }}
                      onDoubleClick={(event) => {
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
                    >
                      {column.render(row, rowIndex)}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
