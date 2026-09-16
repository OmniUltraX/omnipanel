import { useCallback, useEffect, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from "react";
import type { ColumnSizingState } from "@tanstack/react-table";
import type { TableDataGridCanvasBodyHandle } from "./canvas/TableDataGridCanvasBody";
import {
  COLUMN_MIN_WIDTH,
  DEFAULT_ROW_HEIGHT,
  MIN_ROW_HEIGHT,
  ROW_NUM_COL_ID,
  TRANSPOSE_FIELD_COL,
} from "./tableDataGridConstants";
import { applyAllColumnWidthsDom } from "./tableDataGridLayout";
import { isPinnedGridColumn } from "./tableDataGridColumnVirtualization";
import {
  clearDragSelectionPaint,
  paintDragSelection,
  type CellPos,
  type CellRange,
} from "./tableDataGridSelection";

export type UseTableDataGridPointerInteractionDeps = {
  clearGridSelection: () => void;
  wrapRef: RefObject<HTMLDivElement | null>;
  canvasBodyRef: RefObject<TableDataGridCanvasBodyHandle | null>;
  cellRangeRef: MutableRefObject<CellRange | null>;
  selectedRowsRef: MutableRefObject<Set<number>>;
  cellDragRef: MutableRefObject<{ active: boolean; start: CellPos } | null>;
  rowDragRef: MutableRefObject<{ active: boolean; startRow: number; maxCol: number } | null>;
  columnDragRef: MutableRefObject<{ active: boolean; startCol: number; maxRow: number } | null>;
  pendingDragRangeRef: MutableRefObject<CellRange | null>;
  dragSelectionRafRef: MutableRefObject<number | null>;
  leafColumnsRef: MutableRefObject<Array<{ id: string; getSize: () => number }>>;
  tableRowCountRef: MutableRefObject<number>;
  columnWidthAtRef: MutableRefObject<(colIndex: number) => number>;
  transposedRef: MutableRefObject<boolean>;
  dragRef: MutableRefObject<{
    rowIndex: number;
    startY: number;
    startHeight: number;
    lastHeight: number;
  } | null>;
  colResizeRef: MutableRefObject<{
    columnId: string;
    startX: number;
    startWidth: number;
    lastWidth: number;
    widthsById: Record<string, number>;
  } | null>;
  dragRowHeightRef: MutableRefObject<{ rowIndex: number; height: number } | null>;
  dragColumnWidthsRef: MutableRefObject<Record<string, number> | null>;
  cellPreviewOpenRef: MutableRefObject<boolean>;
  reserveSelectionOnEscapeRef: MutableRefObject<boolean>;
  setCellRange: Dispatch<SetStateAction<CellRange | null>>;
  setRowHeights: Dispatch<SetStateAction<Record<number, number>>>;
  setColumnSizing: Dispatch<SetStateAction<ColumnSizingState>>;
  rowHeights: Record<number, number>;
};

/**
 * document/window pointer：拖选、行高/列宽 resize、Escape 清选。
 * 整块搬家，勿拆半；leafColumnsRef / tableRowCountRef / columnWidthAtRef 须在 effect 前由壳同步。
 */
export function useTableDataGridPointerInteraction(deps: UseTableDataGridPointerInteractionDeps) {
  const {
    clearGridSelection,
    wrapRef,
    canvasBodyRef,
    cellRangeRef,
    selectedRowsRef,
    cellDragRef,
    rowDragRef,
    columnDragRef,
    pendingDragRangeRef,
    dragSelectionRafRef,
    leafColumnsRef,
    tableRowCountRef,
    columnWidthAtRef,
    transposedRef,
    dragRef,
    colResizeRef,
    dragRowHeightRef,
    dragColumnWidthsRef,
    cellPreviewOpenRef,
    reserveSelectionOnEscapeRef,
    setCellRange,
    setRowHeights,
    setColumnSizing,
    rowHeights,
  } = deps;

  const beginRowResize = useCallback(
    (rowIndex: number, clientY: number) => {
      const wrap = wrapRef.current;
      const measured = rowHeights[rowIndex] ?? DEFAULT_ROW_HEIGHT;
      dragRef.current = {
        rowIndex,
        startY: clientY,
        startHeight: measured,
        lastHeight: measured,
      };
      dragRowHeightRef.current = { rowIndex, height: measured };
      wrap?.classList.add("db-data-table-wrap--resizing");
      canvasBodyRef.current?.invalidate();
    },
    [rowHeights],
  );

  useEffect(() => {
    const scrollWrapWhileDragging = (
      wrap: HTMLElement,
      clientX: number,
      clientY: number,
      axes: { x?: boolean; y?: boolean } = { x: true, y: true },
    ) => {
      const rect = wrap.getBoundingClientRect();
      const edge = 32;
      let dx = 0;
      let dy = 0;
      // 行拖选只需纵向跟滚；列拖选只需横向跟滚，避免鼠标越出左/上缘时误滚到尽头
      if (axes.y !== false) {
        if (clientY < rect.top + edge) {
          dy = -Math.ceil((edge - (clientY - rect.top)) * 0.7);
        } else if (clientY > rect.bottom - edge) {
          dy = Math.ceil((edge - (rect.bottom - clientY)) * 0.7);
        }
      }
      if (axes.x !== false) {
        if (clientX < rect.left + edge) {
          dx = -Math.ceil((edge - (clientX - rect.left)) * 0.7);
        } else if (clientX > rect.right - edge) {
          dx = Math.ceil((edge - (rect.right - clientX)) * 0.7);
        }
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
      // 表头始终在 DOM，列拖选时需要同步高亮
      paintDragSelection(wrap, pending, tableRowCountRef.current);
      canvasBodyRef.current?.invalidate();
    };

    const resolveDragHit = (clientX: number, clientY: number) => {
      const hit = canvasBodyRef.current?.hitTestClientPoint(clientX, clientY);
      if (!hit) return null;
      return { rowIndex: hit.rowIndex, colIndex: hit.colIndex };
    };

    const isSelectableDataColumn = (colIndex: number): boolean => {
      const col = leafColumnsRef.current[colIndex];
      if (!col) return false;
      if (col.id === ROW_NUM_COL_ID || col.id === TRANSPOSE_FIELD_COL) return false;
      return true;
    };

    /** 列拖选：优先命中表头，其次表体，最后按列宽几何计算（兼容列虚拟化） */
    const resolveColumnDragCol = (clientX: number, clientY: number): number | null => {
      const el = document.elementFromPoint(clientX, clientY);
      const th = el?.closest("th[data-col-id]");
      if (th instanceof HTMLElement) {
        const fromIndex = Number(th.dataset.colIndex);
        if (!Number.isNaN(fromIndex) && isSelectableDataColumn(fromIndex)) {
          return fromIndex;
        }
        const colId = th.dataset.colId;
        if (colId) {
          const idx = leafColumnsRef.current.findIndex((c) => c.id === colId);
          if (idx >= 0 && isSelectableDataColumn(idx)) return idx;
        }
      }
      const hit = resolveDragHit(clientX, clientY);
      if (hit?.colIndex != null && isSelectableDataColumn(hit.colIndex)) {
        return hit.colIndex;
      }

      const wrap = wrapRef.current;
      if (!wrap) return null;
      const rect = wrap.getBoundingClientRect();
      const localX = clientX - rect.left;
      const cols = leafColumnsRef.current;
      if (cols.length === 0) return null;

      let pinnedWidth = 0;
      const widths = cols.map((col, index) => {
        const width = columnWidthAtRef.current(index);
        if (isPinnedGridColumn(col.id, transposedRef.current)) {
          pinnedWidth += width;
        }
        return width;
      });

      const contentX = localX < pinnedWidth ? localX : localX + wrap.scrollLeft;
      let x = 0;
      for (let i = 0; i < cols.length; i += 1) {
        const width = widths[i] ?? 0;
        if (contentX >= x && contentX < x + width) {
          return isSelectableDataColumn(i) ? i : null;
        }
        x += width;
      }
      if (contentX >= x) {
        for (let i = cols.length - 1; i >= 0; i -= 1) {
          if (isSelectableDataColumn(i)) return i;
        }
      }
      return null;
    };

    const onMouseMove = (event: MouseEvent) => {
      const wrap = wrapRef.current;
      if (!wrap) return;

      const rowDrag = rowDragRef.current;
      if (rowDrag?.active) {
        scrollWrapWhileDragging(wrap, event.clientX, event.clientY, { x: false, y: true });
        const hit = resolveDragHit(event.clientX, event.clientY);
        if (hit) {
          pendingDragRangeRef.current = {
            start: { row: rowDrag.startRow, col: 0 },
            end: { row: hit.rowIndex, col: rowDrag.maxCol },
          };
        }
        if (dragSelectionRafRef.current == null) {
          dragSelectionRafRef.current = requestAnimationFrame(() => {
            dragSelectionRafRef.current = null;
            flushDragSelectionPaint();
          });
        }
        return;
      }

      const columnDrag = columnDragRef.current;
      if (columnDrag?.active) {
        scrollWrapWhileDragging(wrap, event.clientX, event.clientY, { x: true, y: false });
        const colIndex = resolveColumnDragCol(event.clientX, event.clientY);
        if (colIndex != null) {
          pendingDragRangeRef.current = {
            start: { row: 0, col: columnDrag.startCol },
            end: { row: columnDrag.maxRow, col: colIndex },
          };
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
        scrollWrapWhileDragging(wrap, event.clientX, event.clientY, { x: true, y: true });
        const hit = resolveDragHit(event.clientX, event.clientY);
        if (hit && hit.colIndex != null) {
          pendingDragRangeRef.current = {
            start: cellDrag.start,
            end: { row: hit.rowIndex, col: hit.colIndex },
          };
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
        dragRowHeightRef.current = { rowIndex: drag.rowIndex, height: next };
        canvasBodyRef.current?.invalidate();
        return;
      }

      const col = colResizeRef.current;
      if (col) {
        const diff = event.clientX - col.startX;
        const newWidth = Math.max(COLUMN_MIN_WIDTH, col.startWidth + diff);
        if (newWidth === col.lastWidth) return;
        col.lastWidth = newWidth;
        const nextWidths = { ...col.widthsById, [col.columnId]: newWidth };
        col.widthsById = nextWidths;
        dragColumnWidthsRef.current = nextWidths;
        const columnIds = leafColumnsRef.current.map((column) => column.id);
        applyAllColumnWidthsDom(wrap, nextWidths, columnIds);
        canvasBodyRef.current?.invalidate();
      }
    };

    const onScrollDuringDrag = () => {
      if (
        !cellDragRef.current?.active &&
        !rowDragRef.current?.active &&
        !columnDragRef.current?.active
      ) {
        return;
      }
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
      const wasColumnDrag = Boolean(columnDragRef.current?.active);
      const pendingDragRange = pendingDragRangeRef.current;

      if (cellDragRef.current) {
        cellDragRef.current = null;
      }
      if (rowDragRef.current) {
        rowDragRef.current = null;
      }
      if (columnDragRef.current) {
        columnDragRef.current = null;
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
      if ((wasCellDrag || wasRowDrag || wasColumnDrag) && pendingDragRange) {
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
        let sizingChanged = false;
        setColumnSizing((prev) => {
          if (prev[col.columnId] === col.lastWidth) return prev;
          sizingChanged = true;
          return { ...prev, [col.columnId]: col.lastWidth };
        });
        wrap?.querySelector(`th[data-col-id="${CSS.escape(col.columnId)}"]`)?.classList.remove("db-data-table-th-resizing");
        // 宽度有变更时保留全列快照直到 columnSizing 布局落地
        dragColumnWidthsRef.current = sizingChanged ? { ...col.widthsById } : null;
      } else {
        dragColumnWidthsRef.current = null;
      }

      dragRef.current = null;
      colResizeRef.current = null;
      dragRowHeightRef.current = null;
      canvasBodyRef.current?.invalidate();
      wrap?.classList.remove("db-data-table-wrap--resizing", "db-data-table-wrap--col-resizing");
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || reserveSelectionOnEscapeRef.current) return;
      if (cellPreviewOpenRef.current) return;
      if (
        cellDragRef.current?.active ||
        rowDragRef.current?.active ||
        columnDragRef.current?.active
      ) {
        cellDragRef.current = null;
        rowDragRef.current = null;
        columnDragRef.current = null;
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

  return { beginRowResize };
}
