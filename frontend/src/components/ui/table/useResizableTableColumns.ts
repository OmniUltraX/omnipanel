import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

export interface ResizableColumnDef {
  id: string;
  defaultWidth: number;
  minWidth?: number;
  resizable?: boolean;
}

interface ColumnDragState {
  columnId: string;
  startX: number;
  startWidth: number;
  lastWidth: number;
}

function buildDefaultWidths(columns: ResizableColumnDef[]): Record<string, number> {
  const widths: Record<string, number> = {};
  for (const column of columns) {
    widths[column.id] = column.defaultWidth;
  }
  return widths;
}

function loadStoredWidths(
  storageKey: string | undefined,
  columns: ResizableColumnDef[],
): Record<string, number> {
  const defaults = buildDefaultWidths(columns);
  if (!storageKey) {
    return defaults;
  }
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) {
      return defaults;
    }
    const parsed = JSON.parse(raw) as Record<string, number>;
    const merged = { ...defaults };
    for (const column of columns) {
      const stored = parsed[column.id];
      if (typeof stored === "number" && Number.isFinite(stored) && stored > 0) {
        merged[column.id] = Math.max(column.minWidth ?? 48, stored);
      }
    }
    return merged;
  } catch {
    return defaults;
  }
}

function applyColumnWidth(
  table: HTMLElement,
  columnId: string,
  width: number,
  constrainMaxWidth: boolean,
) {
  const px = `${width}px`;
  table.querySelectorAll<HTMLElement>(`[data-col-id="${CSS.escape(columnId)}"]`).forEach((el) => {
    el.style.width = px;
    if (el.tagName !== "COL") {
      el.style.minWidth = px;
      if (constrainMaxWidth) {
        el.style.maxWidth = px;
      } else {
        el.style.maxWidth = "";
      }
    }
  });
}

export function useResizableTableColumns(
  columns: ResizableColumnDef[],
  options?: { storageKey?: string; minWidth?: number; /** 为 false 时不锁 maxWidth，便于表格撑满父级 */ constrainMaxWidth?: boolean },
) {
  const globalMinWidth = options?.minWidth ?? 48;
  const constrainMaxWidth = options?.constrainMaxWidth !== false;
  const tableRef = useRef<HTMLTableElement>(null);
  const dragRef = useRef<ColumnDragState | null>(null);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(() =>
    loadStoredWidths(options?.storageKey, columns),
  );
  const [resizingColumnId, setResizingColumnId] = useState<string | null>(null);

  useEffect(() => {
    if (!options?.storageKey) {
      return;
    }
    try {
      localStorage.setItem(options.storageKey, JSON.stringify(columnWidths));
    } catch {
      // ignore quota / private mode
    }
  }, [columnWidths, options?.storageKey]);

  useEffect(() => {
    const table = tableRef.current;
    if (!table) {
      return;
    }
    for (const column of columns) {
      const width = columnWidths[column.id] ?? column.defaultWidth;
      applyColumnWidth(table, column.id, width, constrainMaxWidth);
    }
  }, [columnWidths, columns, constrainMaxWidth]);

  useEffect(() => {
    const onMouseMove = (event: MouseEvent) => {
      const drag = dragRef.current;
      const table = tableRef.current;
      if (!drag || !table) {
        return;
      }
      const column = columns.find((item) => item.id === drag.columnId);
      const minWidth = column?.minWidth ?? globalMinWidth;
      const nextWidth = Math.max(minWidth, drag.startWidth + (event.clientX - drag.startX));
      if (nextWidth === drag.lastWidth) {
        return;
      }
      drag.lastWidth = nextWidth;
      applyColumnWidth(table, drag.columnId, nextWidth, constrainMaxWidth);
    };

    const onMouseUp = () => {
      const drag = dragRef.current;
      if (drag) {
        setColumnWidths((prev) => {
          if (prev[drag.columnId] === drag.lastWidth) {
            return prev;
          }
          return { ...prev, [drag.columnId]: drag.lastWidth };
        });
      }
      dragRef.current = null;
      setResizingColumnId(null);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [columns, constrainMaxWidth, globalMinWidth]);

  const startColumnResize = useCallback(
    (columnId: string, clientX: number) => {
      const column = columns.find((item) => item.id === columnId);
      if (!column || column.resizable === false) {
        return;
      }
      const startWidth = columnWidths[columnId] ?? column.defaultWidth;
      dragRef.current = {
        columnId,
        startX: clientX,
        startWidth,
        lastWidth: startWidth,
      };
      setResizingColumnId(columnId);
    },
    [columnWidths, columns],
  );

  const getColumnStyle = useCallback(
    (columnId: string): CSSProperties => {
      const column = columns.find((item) => item.id === columnId);
      const width = columnWidths[columnId] ?? column?.defaultWidth ?? globalMinWidth;
      if (constrainMaxWidth) {
        return {
          width,
          minWidth: width,
          maxWidth: width,
        };
      }
      return {
        width,
        minWidth: width,
      };
    },
    [columnWidths, columns, constrainMaxWidth, globalMinWidth],
  );

  const isColumnResizable = useCallback(
    (columnId: string) => {
      const column = columns.find((item) => item.id === columnId);
      return column != null && column.resizable !== false;
    },
    [columns],
  );

  return {
    tableRef,
    columnWidths,
    resizingColumnId,
    getColumnStyle,
    startColumnResize,
    isColumnResizable,
  };
}
