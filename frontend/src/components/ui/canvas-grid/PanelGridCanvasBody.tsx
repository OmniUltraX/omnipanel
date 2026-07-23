import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  type ForwardedRef,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from "react";

import { drawGridBody } from "./drawBody";
import {
  buildColumnOffsets,
  buildRowOffsets,
  cellViewportRect,
  hitTestGrid,
} from "./geometry";
import { invalidateCanvasGridThemeCache, measureHeaderHeight, readCanvasGridTheme } from "./theme";
import type {
  CanvasCellDrawModel,
  CanvasCellViewportRect,
  CanvasGridColumnInfo,
  CanvasGridHitResult,
  CanvasGridSnapshot,
  CanvasGridThemeTokens,
} from "./types";

export type PanelGridColumnSpec = {
  id: string;
  width: number;
  pinned?: boolean;
  mono?: boolean;
  copyable?: boolean;
};

export type PanelGridCanvasBodyHandle = {
  hitTestClientPoint: (clientX: number, clientY: number) => CanvasGridHitResult | null;
  getCellViewportRect: (rowIndex: number, colIndex: number) => CanvasCellViewportRect | null;
  invalidate: () => void;
};

export type PanelGridCanvasBodyProps<T> = {
  scrollElementRef: { current: HTMLElement | null };
  columns: PanelGridColumnSpec[];
  rows: T[];
  rowHeight: number;
  getCellText: (row: T, columnId: string, rowIndex: number) => string;
  isRowSelected: (row: T, rowIndex: number) => boolean;
  selectedCell: { rowIndex: number; columnId: string } | null;
  sizerClassName?: string;
  canvasClassName?: string;
  headerHeightCssVar?: string;
  /** 绘制风格：列表（面板）或表格（数据网格） */
  drawStyle?: "spreadsheet" | "list";
  onCellClick?: (
    row: T,
    rowIndex: number,
    columnId: string,
    event: ReactMouseEvent,
  ) => void;
  onRowClick?: (row: T, rowIndex: number, event: ReactMouseEvent) => void;
  onRowDoubleClick?: (
    row: T,
    rowIndex: number,
    columnId: string,
    event: ReactMouseEvent,
  ) => void;
  onRowContextMenu?: (row: T, rowIndex: number, event: ReactMouseEvent) => void;
};

function emptyCellModel(overrides: Partial<CanvasCellDrawModel> = {}): CanvasCellDrawModel {
  return {
    kind: "text",
    text: "",
    dirty: false,
    dirtyKind: "none",
    selected: false,
    dragSelected: false,
    rowSelected: false,
    mono: false,
    canEdit: false,
    showValueBtn: false,
    fieldSortDir: null,
    fieldFiltered: false,
    ...overrides,
  };
}

/** 以表头实际渲染宽度为准，保证 canvas 与 thead 列对齐 */
function measureHeaderColumnWidths(
  host: HTMLElement,
  columnIds: string[],
): number[] | null {
  // 一次性查全部 th，避免 N 次 querySelector（每次都有 DOM 遍历开销）
  const ths = host.querySelectorAll<HTMLTableCellElement>("th[data-col-id]");
  const map = new Map<string, HTMLTableCellElement>();
  for (const th of ths) {
    const id = th.dataset.colId;
    if (id) map.set(id, th);
  }
  const widths: number[] = [];
  for (const id of columnIds) {
    const th = map.get(id);
    if (!th) return null;
    const w = th.getBoundingClientRect().width;
    if (!(w > 0)) return null;
    widths.push(w);
  }
  return widths;
}

export const PanelGridCanvasBody = forwardRef(function PanelGridCanvasBody<T>(
  {
    scrollElementRef,
    columns,
    rows,
    rowHeight,
    getCellText,
    isRowSelected,
    selectedCell,
    sizerClassName = "canvas-grid-sizer",
    canvasClassName = "canvas-grid-canvas",
    headerHeightCssVar = "--db-grid-header-height",
    drawStyle = "list",
    onCellClick,
    onRowClick,
    onRowDoubleClick,
    onRowContextMenu,
  }: PanelGridCanvasBodyProps<T>,
  ref: ForwardedRef<PanelGridCanvasBodyHandle>,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sizerRef = useRef<HTMLDivElement | null>(null);
  const themeRef = useRef<CanvasGridThemeTokens | null>(null);
  const hoverRef = useRef<{ row: number; col: number } | null>(null);
  const rafRef = useRef<number | null>(null);
  const headerHeightRef = useRef(28);
  const snapshotRef = useRef<CanvasGridSnapshot | null>(null);
  const rowOffsetsRef = useRef<number[]>([0]);
  /**
   * 测量结果 cache：列 id 签名没变时复用，避免每次 rebuild 都做 N 次 getBoundingClientRect（强制 reflow）。
   * headerHeight 同理：仅列结构/视口变化时重测。
   */
  const measuredCacheRef = useRef<{ signature: string; widths: number[] | null } | null>(null);
  const structureDirtyRef = useRef(true);

  const columnsRef = useRef(columns);
  columnsRef.current = columns;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const getCellTextRef = useRef(getCellText);
  getCellTextRef.current = getCellText;
  const isRowSelectedRef = useRef(isRowSelected);
  isRowSelectedRef.current = isRowSelected;
  const selectedCellRef = useRef(selectedCell);
  selectedCellRef.current = selectedCell;
  const rowHeightRef = useRef(rowHeight);
  rowHeightRef.current = rowHeight;

  const rebuildSnapshot = useCallback(() => {
    const cols = columnsRef.current;
    const dataRows = rowsRef.current;
    const heights = rowHeightRef.current;
    const host = scrollElementRef.current;
    // 列 id 签名 cache：列结构没变时复用上次测量，跳过 N 次 getBoundingClientRect
    const signature = cols.map((c) => `${c.id}:${c.width}`).join("\u0000");
    const cached = measuredCacheRef.current;
    let measured: number[] | null = null;
    if (host && structureDirtyRef.current) {
      if (cached && cached.signature === signature) {
        measured = cached.widths;
      } else {
        measured = measureHeaderColumnWidths(host, cols.map((c) => c.id));
        measuredCacheRef.current = { signature, widths: measured };
      }
    } else if (cached) {
      measured = cached.widths;
    }
    const widths = cols.map((c, index) => measured?.[index] ?? c.width);
    const { columns: offsets, totalWidth } = buildColumnOffsets(widths);
    const drawColumns: CanvasGridColumnInfo[] = cols.map((col, index) => ({
      id: col.id,
      x: offsets[index]!.x,
      width: offsets[index]!.width,
      pinned: Boolean(col.pinned),
      isRowNum: false,
      isFieldCol: false,
      isRelation: false,
      isRelationDisplay: false,
    }));

    const getRowHeight = () => heights;
    const { offsets: rowOffsets, totalHeight } = buildRowOffsets(dataRows.length, getRowHeight);

    const snapshot: CanvasGridSnapshot = {
      rowCount: dataRows.length,
      columnCount: drawColumns.length,
      columns: drawColumns,
      totalWidth,
      totalHeight,
      defaultRowHeight: heights,
      getRowHeight,
      getRowOffset: (rowIndex) => rowOffsets[rowIndex] ?? 0,
      getCellModel: (rowIndex, colIndex) => {
        const row = dataRows[rowIndex];
        const col = cols[colIndex];
        const drawCol = drawColumns[colIndex];
        if (!row || !col || !drawCol) return null;
        const text = getCellTextRef.current(row, col.id, rowIndex);
        const rowSelected = isRowSelectedRef.current(row, rowIndex);
        const cellSelected =
          selectedCellRef.current?.rowIndex === rowIndex &&
          selectedCellRef.current.columnId === col.id;
        return emptyCellModel({
          text,
          selected: cellSelected,
          rowSelected,
          mono: Boolean(col.mono),
        });
      },
      hoverRow: hoverRef.current?.row ?? null,
      hoverCol: hoverRef.current?.col ?? null,
      nullLabel: "NULL",
      emptyLabel: "EMPTY",
    };

    snapshotRef.current = snapshot;
    rowOffsetsRef.current = rowOffsets;
    if (sizerRef.current) {
      sizerRef.current.style.height = `${totalHeight}px`;
      sizerRef.current.style.width = `${Math.max(totalWidth, 1)}px`;
    }
    return { snapshot, rowOffsets };
  }, [scrollElementRef]);

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = scrollElementRef.current;
    if (!canvas || !wrap) return;

    // 仅结构变化时 rebuild + 重测表头高度（避免每次滚动都 N 次 getBoundingClientRect）
    let snapshot: CanvasGridSnapshot;
    let rowOffsets: number[];
    if (structureDirtyRef.current || !snapshotRef.current) {
      const bundle = rebuildSnapshot();
      snapshot = bundle.snapshot;
      rowOffsets = bundle.rowOffsets;
      structureDirtyRef.current = false;

      // 表头高度也仅结构变化时重测
      const headerHeight = measureHeaderHeight(wrap);
      headerHeightRef.current = headerHeight;
      wrap.style.setProperty(headerHeightCssVar, `${headerHeight}px`);
    } else {
      snapshot = snapshotRef.current;
      rowOffsets = rowOffsetsRef.current;
      // hover 更新
      snapshot.hoverRow = hoverRef.current?.row ?? null;
      snapshot.hoverCol = hoverRef.current?.col ?? null;
    }
    const headerHeight = headerHeightRef.current || 28;

    const scrollTop = wrap.scrollTop;
    const scrollLeft = wrap.scrollLeft;
    const cssWidth = Math.max(1, wrap.clientWidth);
    const fullCssHeight = Math.max(1, wrap.clientHeight - headerHeight);
    // 滚过内容底部时（sticky 表头占位与 headerHeight 微差导致 scrollHeight 偏大），
    // 缩短 canvas 高度使底部对齐内容底部，避免画出无行数据的空白区域。
    const cssHeight = Math.min(fullCssHeight, Math.max(1, snapshot.totalHeight - scrollTop));
    const dpr = window.devicePixelRatio || 1;
    const nextW = Math.floor(cssWidth * dpr);
    const nextH = Math.floor(cssHeight * dpr);

    if (canvas.width !== nextW || canvas.height !== nextH) {
      canvas.width = nextW;
      canvas.height = nextH;
    }
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    canvas.style.left = `${scrollLeft}px`;
    canvas.style.top = `${scrollTop}px`;

    themeRef.current ??= readCanvasGridTheme(wrap, "panel");
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    drawGridBody({
      ctx,
      snapshot,
      theme: themeRef.current,
      rowOffsets,
      scrollLeft,
      scrollTop,
      viewportWidth: cssWidth,
      viewportHeight: cssHeight,
      dpr,
      style: drawStyle,
    });
  }, [drawStyle, headerHeightCssVar, rebuildSnapshot, scrollElementRef]);

  const schedulePaint = useCallback(() => {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      paint();
    });
  }, [paint]);

  useLayoutEffect(() => {
    structureDirtyRef.current = true;
    schedulePaint();
  }, [columns, rows, rowHeight, selectedCell, isRowSelected, getCellText, schedulePaint]);

  useEffect(() => {
    const wrap = scrollElementRef.current;
    if (!wrap) return;

    const onScroll = () => schedulePaint();
    wrap.addEventListener("scroll", onScroll, { passive: true, capture: true });

    const ro = new ResizeObserver(() => {
      themeRef.current = null;
      measuredCacheRef.current = null; // 视口变化可能影响列宽，失效 cache
      structureDirtyRef.current = true;
      schedulePaint();
    });
    ro.observe(wrap);

    const mo = new MutationObserver(() => {
      invalidateCanvasGridThemeCache();
      themeRef.current = null;
      schedulePaint();
    });
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme", "style"],
    });

    onScroll();
    return () => {
      wrap.removeEventListener("scroll", onScroll, true);
      ro.disconnect();
      mo.disconnect();
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [schedulePaint, scrollElementRef]);

  const clientToHit = useCallback(
    (clientX: number, clientY: number): CanvasGridHitResult | null => {
      const canvas = canvasRef.current;
      const wrap = scrollElementRef.current;
      if (!snapshotRef.current) rebuildSnapshot();
      const snap = snapshotRef.current;
      if (!canvas || !wrap || !snap) return null;
      const rect = canvas.getBoundingClientRect();
      const viewportX = clientX - rect.left;
      const viewportY = clientY - rect.top;
      if (viewportX < 0 || viewportY < 0 || viewportX > rect.width || viewportY > rect.height) {
        return null;
      }
      return hitTestGrid(
        snap,
        rowOffsetsRef.current,
        viewportX,
        viewportY,
        wrap.scrollLeft,
        wrap.scrollTop,
      );
    },
    [rebuildSnapshot, scrollElementRef],
  );

  const getCellViewportRectFn = useCallback(
    (rowIndex: number, colIndex: number): CanvasCellViewportRect | null => {
      const wrap = scrollElementRef.current;
      const snapshot = snapshotRef.current ?? rebuildSnapshot().snapshot;
      if (!wrap) return null;
      return cellViewportRect(
        snapshot,
        rowOffsetsRef.current,
        rowIndex,
        colIndex,
        wrap.scrollLeft,
        wrap.scrollTop,
        wrap.getBoundingClientRect(),
        headerHeightRef.current,
      );
    },
    [rebuildSnapshot, scrollElementRef],
  );

  useImperativeHandle(
    ref,
    () => ({
      hitTestClientPoint: clientToHit,
      getCellViewportRect: getCellViewportRectFn,
      invalidate: schedulePaint,
    }),
    [clientToHit, getCellViewportRectFn, schedulePaint],
  );

  const handleMouseDown = useCallback(
    (event: ReactMouseEvent<HTMLCanvasElement>) => {
      if (event.button !== 0 || event.detail >= 2) return;
      const hit = clientToHit(event.clientX, event.clientY);
      if (!hit) return;
      const row = rowsRef.current[hit.rowIndex];
      const col = columnsRef.current[hit.colIndex];
      if (!row || !col) return;
      if (col.copyable !== false && onCellClick) {
        onCellClick(row, hit.rowIndex, col.id, event);
        return;
      }
      onRowClick?.(row, hit.rowIndex, event);
    },
    [clientToHit, onCellClick, onRowClick],
  );

  const handleDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLCanvasElement>) => {
      const hit = clientToHit(event.clientX, event.clientY);
      if (!hit) return;
      const row = rowsRef.current[hit.rowIndex];
      const col = columnsRef.current[hit.colIndex];
      if (!row || !col) return;
      onRowDoubleClick?.(row, hit.rowIndex, col.id, event);
    },
    [clientToHit, onRowDoubleClick],
  );

  const handleContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLCanvasElement>) => {
      const hit = clientToHit(event.clientX, event.clientY);
      if (!hit) return;
      const row = rowsRef.current[hit.rowIndex];
      if (!row || !onRowContextMenu) return;
      event.preventDefault();
      onRowContextMenu(row, hit.rowIndex, event);
    },
    [clientToHit, onRowContextMenu],
  );

  const handleMouseMove = useCallback(
    (event: ReactMouseEvent<HTMLCanvasElement>) => {
      const hit = clientToHit(event.clientX, event.clientY);
      const next = hit ? { row: hit.rowIndex, col: hit.colIndex } : null;
      const prev = hoverRef.current;
      if (prev?.row !== next?.row || prev?.col !== next?.col) {
        hoverRef.current = next;
        schedulePaint();
      }
      if (canvasRef.current) {
        canvasRef.current.style.cursor = hit ? "pointer" : "default";
      }
    },
    [clientToHit, schedulePaint],
  );

  const handleMouseLeave = useCallback(() => {
    if (hoverRef.current) {
      hoverRef.current = null;
      schedulePaint();
    }
    if (canvasRef.current) {
      canvasRef.current.style.cursor = "default";
    }
  }, [schedulePaint]);

  const initialSize = useMemo(() => {
    const totalWidth = columns.reduce((sum, col) => sum + col.width, 0);
    return {
      height: Math.max(rowHeight, rows.length * rowHeight),
      width: Math.max(totalWidth, 1),
    };
  }, [columns, rowHeight, rows.length]);

  return (
    <div
      ref={sizerRef}
      className={sizerClassName}
      style={{ height: initialSize.height, width: initialSize.width }}
      aria-hidden
    >
      <canvas
        ref={canvasRef}
        className={canvasClassName}
        onMouseDown={handleMouseDown}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      />
    </div>
  );
}) as <T>(
  props: PanelGridCanvasBodyProps<T> & { ref?: ForwardedRef<PanelGridCanvasBodyHandle> },
) => ReactElement;
