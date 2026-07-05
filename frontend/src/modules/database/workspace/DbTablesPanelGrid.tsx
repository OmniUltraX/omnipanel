import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

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
}

interface CellSelection {
  rowKey: string | number;
  columnId: string;
}

const GRID_ROW_HEIGHT = 32;
const GRID_VIRTUAL_OVERSCAN = 10;

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

function tableClassName(variant: DbTablesPanelGridVariant, className?: string): string {
  const classes = ["db-tables-panel-grid"];
  if (variant !== "default") {
    classes.push(`db-tables-panel-grid--${variant}`);
  }
  if (className) {
    classes.push(className);
  }
  return classes.join(" ");
}

type VirtualGridRowProps<T> = {
  row: T;
  rowIndex: number;
  rowId: string | number;
  columns: DbTablesPanelGridColumn<T>[];
  selectedRowKey: string | number | null;
  selectedCell: CellSelection | null;
  rowClassName?: (row: T) => string | undefined;
  onRowClick?: (row: T) => void;
  onSelectCell: (selection: CellSelection) => void;
  resolveCopyText: (row: T, column: DbTablesPanelGridColumn<T>) => string;
  t: (key: string) => string;
};

const VirtualGridRow = memo(function VirtualGridRow<T>({
  row,
  rowIndex,
  rowId,
  columns,
  selectedRowKey,
  selectedCell,
  rowClassName,
  onRowClick,
  onSelectCell,
  resolveCopyText,
  t,
}: VirtualGridRowProps<T>) {
  const selected = selectedRowKey != null && selectedRowKey === rowId;
  const extraClass = rowClassName?.(row);

  return (
    <tr
      className={[selected ? "is-selected" : "", extraClass ?? ""].filter(Boolean).join(" ") || undefined}
      onClick={onRowClick ? () => onRowClick(row) : undefined}
    >
      {columns.map((column) => {
        const title = column.getTitle?.(row);
        const copyable = isColumnCopyable(column);
        const cellSelected = selectedCell?.rowKey === rowId && selectedCell.columnId === column.id;
        const cellClass = bodyCellClassName(
          column as DbTablesPanelGridColumn<unknown>,
          cellSelected,
          copyable,
        );
        return (
          <td
            key={column.id}
            className={cellClass || undefined}
            title={title}
            onClick={(event) => {
              if (!copyable) {
                return;
              }
              event.stopPropagation();
              onSelectCell({ rowKey: rowId, columnId: column.id });
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
}) as <T>(props: VirtualGridRowProps<T>) => React.ReactElement;

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
}: DbTablesPanelGridProps<T>) {
  const { t } = useI18n();
  const hostRef = useRef<HTMLDivElement>(null);
  const [selectedCell, setSelectedCell] = useState<CellSelection | null>(null);

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

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => hostRef.current,
    estimateSize: () => GRID_ROW_HEIGHT,
    overscan: GRID_VIRTUAL_OVERSCAN,
    getItemKey: (index) => String(rowKey(rows[index]!, index)),
  });

  const virtualRows = rowVirtualizer.getVirtualItems();
  const paddingTop = virtualRows.length > 0 ? virtualRows[0]!.start : 0;
  const paddingBottom =
    virtualRows.length > 0
      ? rowVirtualizer.getTotalSize() - virtualRows[virtualRows.length - 1]!.end
      : 0;

  return (
    <div ref={hostRef} className="db-tables-panel-grid-host" tabIndex={-1}>
      <table className={tableClassName(variant, className)}>
        <thead>
          <tr>
            {columns.map((column) => {
              const sortId = column.sortId ?? column.id;
              const sortable = column.sortable && onSortColumn != null;
              return (
                <th
                  key={column.id}
                  className={headerCellClassName(
                    column as DbTablesPanelGridColumn<unknown>,
                    sortColumnId,
                    sortDirection,
                  )}
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
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {paddingTop > 0 ? (
            <tr aria-hidden>
              <td colSpan={columns.length} style={{ height: paddingTop, padding: 0, border: "none" }} />
            </tr>
          ) : null}
          {virtualRows.map((virtualRow) => {
            const row = rows[virtualRow.index];
            if (!row) return null;
            const rowIndex = virtualRow.index;
            const key = rowKey(row, rowIndex);
            return (
              <VirtualGridRow
                key={key}
                row={row}
                rowIndex={rowIndex}
                rowId={key}
                columns={columns}
                selectedRowKey={selectedRowKey}
                selectedCell={selectedCell}
                rowClassName={rowClassName}
                onRowClick={onRowClick}
                onSelectCell={setSelectedCell}
                resolveCopyText={resolveCopyText}
                t={t}
              />
            );
          })}
          {paddingBottom > 0 ? (
            <tr aria-hidden>
              <td colSpan={columns.length} style={{ height: paddingBottom, padding: 0, border: "none" }} />
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
