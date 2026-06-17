import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnSizingState,
} from "@tanstack/react-table";

import { Button } from "../../components/ui/Button";
import { useI18n } from "../../i18n";
import { type DbColumnMeta } from "./api";

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
  /** 已修改的行 key 集合（来自父组件脏数据状态），用于高亮 */
  dirtyRowKeys?: Set<string>;
  /** 单元覆盖：行 key -> 列名 -> 覆盖值；优先于 rows 展示 */
  cellOverrides?: Record<string, Record<string, unknown>>;
  /** 显示行列转换切换按钮（表数据预览） */
  enableTranspose?: boolean;
};

function buildRowKey(row: Record<string, unknown>, pkCols: { name: string }[]): string {
  if (pkCols.length === 0) return "";
  return pkCols
    .map((pk) => `${pk.name}=${row[pk.name] == null ? "" : String(row[pk.name])}`)
    .join("&");
}

const MIN_ROW_HEIGHT = 28;
const DEFAULT_ROW_HEIGHT = 36;
const ROW_RESIZE_ZONE_PX = 8;
const COLUMN_MIN_WIDTH = 60;

function cellToText(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function isNearRowBottom(target: HTMLElement, clientY: number): boolean {
  const rect = target.getBoundingClientRect();
  return clientY >= rect.bottom - ROW_RESIZE_ZONE_PX;
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

export function TableDataGrid({ columns, rows, totalRows, page, pageSize, loading, onPageChange, columnMeta, onCellEdit, dirtyRowKeys, cellOverrides, enableTranspose = false }: TableDataGridProps) {
  const { t } = useI18n();
  const [transposed, setTransposed] = useState(false);
  const [rowHeights, setRowHeights] = useState<Record<number, number>>({});
  const [resizingRow, setResizingRow] = useState<number | null>(null);
  const [resizeHintRow, setResizeHintRow] = useState<number | null>(null);
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>({});
  const dragRef = useRef<{
    rowIndex: number;
    startY: number;
    startHeight: number;
  } | null>(null);
  const colResizeRef = useRef<{
    columnId: string;
    startX: number;
    startWidth: number;
  } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const savedScrollRef = useRef({ left: 0, top: 0 });
  const restoreScrollAfterPageChangeRef = useRef(false);

  const handlePageChange = useCallback(
    (nextPage: number) => {
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
    setResizingRow(null);
    setResizeHintRow(null);
    dragRef.current = null;
  }, [columns, transposed]);

  const transposedData = useMemo(() => {
    if (!transposed) return null;
    return transposeGridData(columns, rows, page, pageSize, columnMeta);
  }, [transposed, columns, rows, page, pageSize, columnMeta]);

  const transposedDirty = useMemo(() => {
    if (!transposed) return null;
    return transposeDirtyState(rows, columnMeta, dirtyRowKeys, cellOverrides);
  }, [transposed, rows, columnMeta, dirtyRowKeys, cellOverrides]);

  const displayColumns = transposed ? transposedData!.columns : columns;
  const displayRows = transposed ? transposedData!.rows : rows;
  const displayDirtyRowKeys = transposed ? transposedDirty!.dirtyRowKeys : dirtyRowKeys;
  const displayCellOverrides = transposed ? transposedDirty!.cellOverrides : cellOverrides;
  const effectiveOnCellEdit = transposed ? undefined : onCellEdit;
  const transposeRowHeaders = transposedData?.rowHeaders ?? [];

  const columnMetaMap = useMemo(() => {
    if (!columnMeta) return null;
    const map: Record<string, DbColumnMeta> = {};
    for (const m of columnMeta) {
      map[m.name] = m;
    }
    return map;
  }, [columnMeta]);

  const columnDefs = useMemo<ColumnDef<Record<string, unknown>>[]>(
    () =>
      displayColumns.map((col) => {
        const isFieldCol = transposed && col === TRANSPOSE_FIELD_COL;
        const rowHeaderIndex = transposed ? parseInt(col.replace("__row__", ""), 10) : -1;
        const headerLabel = isFieldCol
          ? t("database.results.transposeField")
          : transposed && !Number.isNaN(rowHeaderIndex)
            ? transposeRowHeaders[rowHeaderIndex] ?? col
            : col;
        return {
          id: col,
          accessorFn: (row) => row[col],
          header: headerLabel,
          cell: ({ getValue }) => {
            const value = getValue();
            return <span>{cellToText(value)}</span>;
          },
          minSize: isFieldCol ? 100 : COLUMN_MIN_WIDTH,
          size: isFieldCol ? 140 : 150,
        };
      }),
    [displayColumns, transposed, transposeRowHeaders, columnMetaMap, t],
  );

  const table = useReactTable({
    data: displayRows,
    columns: columnDefs,
    state: { columnSizing },
    onColumnSizingChange: setColumnSizing,
    columnResizeMode: "onChange",
    enableColumnResizing: true,
    getCoreRowModel: getCoreRowModel(),
  });

  const beginRowResize = useCallback(
    (rowIndex: number, clientY: number) => {
      const measured =
        rowHeights[rowIndex] ??
        document
          .querySelector<HTMLTableRowElement>(
            `tr[data-row-index="${rowIndex}"]`,
          )
          ?.getBoundingClientRect().height ??
        DEFAULT_ROW_HEIGHT;
      dragRef.current = {
        rowIndex,
        startY: clientY,
        startHeight: measured,
      };
      setResizingRow(rowIndex);
    },
    [rowHeights],
  );

  useEffect(() => {
    const onMouseMove = (event: MouseEvent) => {
      const drag = dragRef.current;
      if (drag) {
        const next = Math.max(
          MIN_ROW_HEIGHT,
          drag.startHeight + (event.clientY - drag.startY),
        );
        setRowHeights((prev) => {
          if (prev[drag.rowIndex] === next) {
            return prev;
          }
          return { ...prev, [drag.rowIndex]: next };
        });
        return;
      }
      const col = colResizeRef.current;
      if (col) {
        const diff = event.clientX - col.startX;
        const newWidth = Math.max(COLUMN_MIN_WIDTH, col.startWidth + diff);
        setColumnSizing((prev) => {
          if (prev[col.columnId] === newWidth) return prev;
          return { ...prev, [col.columnId]: newWidth };
        });
      }
    };

    const endResize = () => {
      dragRef.current = null;
      colResizeRef.current = null;
      setResizingRow(null);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", endResize);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", endResize);
    };
  }, []);

  if (displayColumns.length === 0) {
    return null;
  }

  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const showingFrom = totalRows === 0 ? 0 : page * pageSize + 1;
  const showingTo = Math.min((page + 1) * pageSize, totalRows);

  return (
    <>
    <div
      ref={wrapRef}
      className={`db-data-table-wrap${transposed ? " db-data-table-wrap--transposed" : ""}${resizingRow !== null ? " db-data-table-wrap--resizing" : ""}${table.getState().columnSizingInfo?.isResizingColumn ? " db-data-table-wrap--col-resizing" : ""}`}
    >
      <table className="db-data-table">
        <thead>
                {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header) => {
                return (
                <th
                  key={header.id}
                  style={{ width: header.getSize() }}
                  className={table.getState().columnSizingInfo?.isResizingColumn === header.column.id ? "db-data-table-th-resizing" : ""}
                >
                  {header.isPlaceholder
                    ? null
                    : flexRender(header.column.columnDef.header, header.getContext())}
                  {header.column.getCanResize() && (
                    <div
                      className="db-col-resize-handle"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        colResizeRef.current = {
                          columnId: header.column.id,
                          startX: e.clientX,
                          startWidth: header.getSize(),
                        };
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
          {table.getRowModel().rows.map((row) => {
            const rowHeight = rowHeights[row.index];
            const isCustomHeight = rowHeight !== undefined;
            const pkCols = (columnMeta ?? []).filter((c) => c.isPk);
            const rowKey = transposed
              ? String(row.original[TRANSPOSE_FIELD_COL] ?? "")
              : pkCols.length > 0
                ? buildRowKey(row.original, pkCols)
                : "";
            const rowDirty = rowKey ? (displayDirtyRowKeys?.has(rowKey) ?? false) : false;
            const overrideForRow = rowKey ? displayCellOverrides?.[rowKey] : undefined;

            return (
              <tr
                key={row.id}
                data-row-index={row.index}
                className={`db-data-table-row${isCustomHeight ? " db-data-table-row--custom-h" : ""}${resizingRow === row.index ? " db-data-table-row--resizing" : ""}${resizeHintRow === row.index ? " db-data-table-row--resize-hint" : ""}${rowDirty ? " db-data-table-row--dirty" : ""}`}
                style={isCustomHeight ? { height: rowHeight } : undefined}
                onMouseDown={(event) => {
                  if (!isNearRowBottom(event.currentTarget, event.clientY)) {
                    return;
                  }
                  event.preventDefault();
                  beginRowResize(row.index, event.clientY);
                }}
                onMouseMove={(event) => {
                  if (resizingRow !== null) {
                    return;
                  }
                  const nearBottom = isNearRowBottom(event.currentTarget, event.clientY);
                  event.currentTarget.style.cursor = nearBottom ? "row-resize" : "";
                  setResizeHintRow(nearBottom ? row.index : null);
                }}
                onMouseLeave={(event) => {
                  event.currentTarget.style.cursor = "";
                  setResizeHintRow((prev) => (prev === row.index ? null : prev));
                }}
              >
                {row.getVisibleCells().map((cell) => {
                  const colMeta = transposed ? undefined : columnMetaMap?.[cell.column.id];
                  const canEdit = effectiveOnCellEdit && colMeta && !colMeta.isPk;
                  const overrideValue = overrideForRow?.[cell.column.id];
                  const cellDirty = overrideValue !== undefined && rowDirty;
                  const rawValue = overrideValue !== undefined ? overrideValue : cell.getValue();
                  const cellTitle = cellToText(rawValue);
                  return (
                    <td
                      key={cell.id}
                      className={`db-data-table-cell${isCustomHeight ? " db-data-table-cell--custom-h" : ""}${columnSizing[cell.column.id] !== undefined ? " db-data-table-cell--sized" : ""}${canEdit ? " db-cell--editable" : ""}${cellDirty ? " db-data-table-cell--dirty" : ""}${transposed && cell.column.id === TRANSPOSE_FIELD_COL ? " db-data-table-cell--field" : ""}`}
                      onDoubleClick={canEdit ? () => effectiveOnCellEdit!({ rowIndex: cell.row.index, column: cell.column.id, row: cell.row.original }) : undefined}
                      title={cellTitle}
                    >
                      {overrideValue !== undefined
                        ? flexRender(
                            typeof overrideValue === "object" && overrideValue !== null
                              ? () => cellToText(overrideValue)
                              : () => cellToText(overrideValue),
                            cell.getContext(),
                          )
                        : flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
    <div className="db-pagination">
      <div className="db-pagination-info">
        {enableTranspose && (
          <Button
            variant={transposed ? "primary" : "ghost"}
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
        {loading ? (
          <span>Loading...</span>
        ) : totalRows > 0 ? (
          <span>
            {showingFrom.toLocaleString()}–{showingTo.toLocaleString()} of{" "}
            {totalRows.toLocaleString()} rows
          </span>
        ) : (
          <span>0 rows</span>
        )}
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
    </>
  );
}
