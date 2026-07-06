import { useCallback, useEffect, useRef, useState } from "react";

export const ROW_DIFF_COL_KEY = "__rowKey";
export const ROW_DIFF_COL_KIND = "__kind";
export const ROW_DIFF_COL_ACTIONS = "__actions";

const MIN_COL_WIDTH = 52;

const DEFAULT_WIDTH_BY_COL: Record<string, number> = {
  [ROW_DIFF_COL_KEY]: 160,
  [ROW_DIFF_COL_KIND]: 80,
  [ROW_DIFF_COL_ACTIONS]: 124,
};

const DEFAULT_DATA_COL_WIDTH = 120;

function defaultWidthForColumn(colId: string): number {
  return DEFAULT_WIDTH_BY_COL[colId] ?? DEFAULT_DATA_COL_WIDTH;
}

function buildDefaultColumnWidths(columnNames: string[]): Record<string, number> {
  const widths: Record<string, number> = {
    [ROW_DIFF_COL_KEY]: defaultWidthForColumn(ROW_DIFF_COL_KEY),
    [ROW_DIFF_COL_KIND]: defaultWidthForColumn(ROW_DIFF_COL_KIND),
    [ROW_DIFF_COL_ACTIONS]: defaultWidthForColumn(ROW_DIFF_COL_ACTIONS),
  };
  for (const name of columnNames) {
    widths[name] = DEFAULT_DATA_COL_WIDTH;
  }
  return widths;
}

function applyRowDiffColumnWidth(scrollRoot: HTMLElement | null, columnId: string, width: number) {
  if (!scrollRoot) {
    return;
  }
  const px = `${width}px`;
  scrollRoot.querySelectorAll<HTMLElement>(`[data-col-id="${CSS.escape(columnId)}"]`).forEach((el) => {
    el.style.width = px;
    el.style.minWidth = px;
    el.style.maxWidth = px;
  });
}

export function useRowDiffColumnResize(columnNames: string[], resetKey: string) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const colResizeRef = useRef<{
    columnId: string;
    startX: number;
    startWidth: number;
    lastWidth: number;
  } | null>(null);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(() =>
    buildDefaultColumnWidths(columnNames),
  );
  const [resizingColumnId, setResizingColumnId] = useState<string | null>(null);

  useEffect(() => {
    setColumnWidths(buildDefaultColumnWidths(columnNames));
  }, [resetKey, columnNames.join("\0")]);

  const beginColumnResize = useCallback((columnId: string, clientX: number, startWidth: number) => {
    colResizeRef.current = {
      columnId,
      startX: clientX,
      startWidth,
      lastWidth: startWidth,
    };
    setResizingColumnId(columnId);
    scrollRef.current?.classList.add("db-toolbox-row-diff-scroll--col-resizing");
    scrollRef.current
      ?.querySelector(`th[data-col-id="${CSS.escape(columnId)}"]`)
      ?.classList.add("db-toolbox-row-diff-th--resizing");
  }, []);

  const resetColumnWidth = useCallback((columnId: string) => {
    const width = defaultWidthForColumn(columnId);
    setColumnWidths((prev) => ({ ...prev, [columnId]: width }));
    applyRowDiffColumnWidth(scrollRef.current, columnId, width);
  }, []);

  useEffect(() => {
    const onMouseMove = (event: MouseEvent) => {
      const col = colResizeRef.current;
      if (!col) {
        return;
      }
      const nextWidth = Math.max(
        MIN_COL_WIDTH,
        col.startWidth + (event.clientX - col.startX),
      );
      if (nextWidth === col.lastWidth) {
        return;
      }
      col.lastWidth = nextWidth;
      applyRowDiffColumnWidth(scrollRef.current, col.columnId, nextWidth);
    };

    const endResize = () => {
      const col = colResizeRef.current;
      if (!col) {
        return;
      }
      setColumnWidths((prev) => {
        if (prev[col.columnId] === col.lastWidth) {
          return prev;
        }
        return { ...prev, [col.columnId]: col.lastWidth };
      });
      scrollRef.current?.classList.remove("db-toolbox-row-diff-scroll--col-resizing");
      scrollRef.current
        ?.querySelector(`th[data-col-id="${CSS.escape(col.columnId)}"]`)
        ?.classList.remove("db-toolbox-row-diff-th--resizing");
      colResizeRef.current = null;
      setResizingColumnId(null);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", endResize);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", endResize);
    };
  }, []);

  const columnIds = [
    ROW_DIFF_COL_KEY,
    ROW_DIFF_COL_KIND,
    ...columnNames,
    ROW_DIFF_COL_ACTIONS,
  ];

  const resolveColumnWidth = useCallback(
    (columnId: string) => columnWidths[columnId] ?? defaultWidthForColumn(columnId),
    [columnWidths],
  );

  const columnWidthStyle = useCallback(
    (columnId: string) => {
      const width = resolveColumnWidth(columnId);
      return { width, minWidth: width, maxWidth: width };
    },
    [resolveColumnWidth],
  );

  return {
    scrollRef,
    columnIds,
    columnWidths,
    resizingColumnId,
    beginColumnResize,
    resetColumnWidth,
    resolveColumnWidth,
    columnWidthStyle,
  };
}
