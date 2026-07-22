import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type MutableRefObject,
  type MouseEvent as ReactMouseEvent,
} from "react";

import type { TableDataGridBodyActions, GridBodyCellInteractionContext } from "../TableDataGridBody";
import type { CellOverlayAnchor } from "../tableCellPreview";
import type { CellRange } from "../tableDataGridSelection";
import { ROW_NUM_COL_ID, TRANSPOSE_FIELD_COL } from "../tableDataGridConstants";
import { buildGridSnapshotBundle, type BuildGridSnapshotInput } from "./buildGridSnapshot";
import { drawGridBody } from "./drawGridBody";
import { cellViewportRect, hitTestGrid } from "./gridGeometry";
import { measureHeaderHeight, readGridTheme } from "./readGridTheme";
import type {
  CellViewportRect,
  GridHitResult,
  GridRenderSnapshot,
  GridThemeTokens,
} from "./gridRenderTypes";

export type TableDataGridCanvasBodyHandle = {
  scrollToIndex: (
    index: number,
    options?: { align?: "start" | "center" | "end" | "auto"; behavior?: "auto" | "smooth" },
  ) => void;
  hitTestClientPoint: (clientX: number, clientY: number) => GridHitResult | null;
  getCellViewportRect: (rowIndex: number, colIndex: number) => CellViewportRect | null;
  invalidate: () => void;
};

export type TableDataGridCanvasBodyProps = {
  scrollElementRef: MutableRefObject<HTMLElement | null>;
  snapshotInput: BuildGridSnapshotInput;
  /** 拖选过程中的临时选区（不走 React state） */
  dragRangeRef: MutableRefObject<CellRange | null>;
  /** 行高拖拽过程中的临时高度 */
  dragRowHeightRef: MutableRefObject<{ rowIndex: number; height: number } | null>;
  /** 列宽拖拽过程中的临时宽度 */
  dragColumnWidthRef: MutableRefObject<{ columnId: string; width: number } | null>;
  bodyActionsRef: MutableRefObject<TableDataGridBodyActions | null>;
  resolveCellContext: (
    rowIndex: number,
    colIndex: number,
  ) => GridBodyCellInteractionContext | null;
  onFieldSortClick?: (fieldName: string) => void;
  onFieldFilterOpen?: (anchor: CellOverlayAnchor, fieldName: string) => void;
};

export const TableDataGridCanvasBody = forwardRef<
  TableDataGridCanvasBodyHandle,
  TableDataGridCanvasBodyProps
>(function TableDataGridCanvasBody(
  {
    scrollElementRef,
    snapshotInput,
    dragRangeRef,
    dragRowHeightRef,
    dragColumnWidthRef,
    bodyActionsRef,
    resolveCellContext,
    onFieldSortClick,
    onFieldFilterOpen,
  },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sizerRef = useRef<HTMLDivElement | null>(null);
  const themeRef = useRef<GridThemeTokens | null>(null);
  const hoverRef = useRef<{ row: number; col: number } | null>(null);
  const rafRef = useRef<number | null>(null);
  const headerHeightRef = useRef(28);
  const snapshotRef = useRef<GridRenderSnapshot | null>(null);
  const rowOffsetsRef = useRef<number[]>([0]);
  const snapshotInputRef = useRef(snapshotInput);
  snapshotInputRef.current = snapshotInput;
  const scrollTopRef = useRef(0);
  const scrollLeftRef = useRef(0);

  const rebuildSnapshot = useCallback(() => {
    const bundle = buildGridSnapshotBundle({
      ...snapshotInputRef.current,
      dragRange: dragRangeRef.current,
      dragRowHeight: dragRowHeightRef.current,
      dragColumnWidth: dragColumnWidthRef.current,
      hoverRow: hoverRef.current?.row ?? null,
      hoverCol: hoverRef.current?.col ?? null,
    });
    snapshotRef.current = bundle.snapshot;
    rowOffsetsRef.current = bundle.rowOffsets;
    if (sizerRef.current) {
      sizerRef.current.style.height = `${bundle.snapshot.totalHeight}px`;
      sizerRef.current.style.width = `${Math.max(bundle.snapshot.totalWidth, 1)}px`;
    }
    return bundle;
  }, [dragRangeRef, dragRowHeightRef, dragColumnWidthRef]);

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = scrollElementRef.current;
    if (!canvas || !wrap) return;

    const { snapshot, rowOffsets } = rebuildSnapshot();
    const headerHeight = measureHeaderHeight(wrap);
    headerHeightRef.current = headerHeight;
    wrap.style.setProperty("--db-grid-header-height", `${headerHeight}px`);

    // 以 wrap 当前滚动为准；sticky canvas 固定在视口，内容偏移 = scrollTop
    scrollTopRef.current = wrap.scrollTop;
    scrollLeftRef.current = wrap.scrollLeft;

    const cssWidth = Math.max(1, wrap.clientWidth);
    const cssHeight = Math.max(1, wrap.clientHeight - headerHeight);
    const dpr = window.devicePixelRatio || 1;
    const nextW = Math.floor(cssWidth * dpr);
    const nextH = Math.floor(cssHeight * dpr);

    if (canvas.width !== nextW || canvas.height !== nextH) {
      canvas.width = nextW;
      canvas.height = nextH;
    }
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;

    themeRef.current ??= readGridTheme(wrap);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    drawGridBody({
      ctx,
      snapshot,
      theme: themeRef.current,
      rowOffsets,
      scrollLeft: scrollLeftRef.current,
      scrollTop: scrollTopRef.current,
      viewportWidth: cssWidth,
      viewportHeight: cssHeight,
      dpr,
    });
  }, [rebuildSnapshot, scrollElementRef]);

  const schedulePaint = useCallback(() => {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      paint();
    });
  }, [paint]);

  useLayoutEffect(() => {
    schedulePaint();
  }, [snapshotInput, schedulePaint]);

  useEffect(() => {
    const wrap = scrollElementRef.current;
    if (!wrap) return;

    const onScroll = () => {
      scrollTopRef.current = wrap.scrollTop;
      scrollLeftRef.current = wrap.scrollLeft;
      schedulePaint();
    };
    // 捕获阶段确保一定收到滚动（部分 WebView 上冒泡可能被吃掉）
    wrap.addEventListener("scroll", onScroll, { passive: true, capture: true });

    const ro = new ResizeObserver(() => {
      themeRef.current = null;
      schedulePaint();
    });
    ro.observe(wrap);

    const mo = new MutationObserver(() => {
      themeRef.current = null;
      schedulePaint();
    });
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme", "style"],
    });

    // 首帧强制对齐一次滚动位置
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
  }, [scrollElementRef, schedulePaint]);

  const clientToHit = useCallback(
    (clientX: number, clientY: number): GridHitResult | null => {
      const canvas = canvasRef.current;
      const wrap = scrollElementRef.current;
      if (!snapshotRef.current) {
        rebuildSnapshot();
      }
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

  const getCellViewportRect = useCallback(
    (rowIndex: number, colIndex: number): CellViewportRect | null => {
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
      scrollToIndex: (index, options) => {
        const wrap = scrollElementRef.current;
        if (!wrap) return;
        if (!snapshotRef.current) rebuildSnapshot();
        const offset = rowOffsetsRef.current[index] ?? 0;
        const rowHeight = snapshotRef.current?.getRowHeight(index) ?? 32;
        const headerHeight = headerHeightRef.current;
        const viewHeight = wrap.clientHeight - headerHeight;
        let top = offset;
        const align = options?.align ?? "auto";
        if (align === "center") {
          top = Math.max(0, offset - (viewHeight - rowHeight) / 2);
        } else if (align === "end") {
          top = Math.max(0, offset - viewHeight + rowHeight);
        }
        wrap.scrollTo({ top, behavior: options?.behavior ?? "auto" });
      },
      hitTestClientPoint: clientToHit,
      getCellViewportRect,
      invalidate: schedulePaint,
    }),
    [clientToHit, getCellViewportRect, rebuildSnapshot, schedulePaint, scrollElementRef],
  );

  const anchorFromHit = useCallback(
    (hit: GridHitResult): CellOverlayAnchor => {
      const rect = getCellViewportRect(hit.rowIndex, hit.colIndex);
      if (rect) return rect;
      return {
        left: hit.cellRect.x,
        top: hit.cellRect.y,
        width: hit.cellRect.width,
        height: hit.cellRect.height,
      };
    },
    [getCellViewportRect],
  );

  const handleMouseDown = useCallback(
    (event: ReactMouseEvent<HTMLCanvasElement>) => {
      const actions = bodyActionsRef.current;
      if (!actions || event.button !== 0) return;
      const hit = clientToHit(event.clientX, event.clientY);
      if (!hit) return;
      const ctx = resolveCellContext(hit.rowIndex, hit.colIndex);
      if (!ctx) return;

      if (hit.region === "valueBtn" && actions.handleOpenValuePanel) {
        event.preventDefault();
        event.stopPropagation();
        actions.handleOpenValuePanel(ctx);
        return;
      }

      if (hit.region === "fieldSort" && onFieldSortClick) {
        event.preventDefault();
        event.stopPropagation();
        onFieldSortClick(ctx.fieldName);
        return;
      }

      if (hit.region === "fieldFilter" && onFieldFilterOpen) {
        event.preventDefault();
        event.stopPropagation();
        onFieldFilterOpen(anchorFromHit(hit), ctx.fieldName);
        return;
      }

      if (hit.region === "rowResize") {
        event.preventDefault();
        event.stopPropagation();
        actions.beginRowResize(ctx.rowIndex, event.clientY);
        return;
      }

      const isRowSelector =
        ctx.columnId === ROW_NUM_COL_ID || ctx.columnId === TRANSPOSE_FIELD_COL;
      if (isRowSelector || hit.region === "rownum" || hit.region === "field") {
        event.preventDefault();
        event.stopPropagation();
        actions.handleRowBandSelect(ctx.rowIndex, event);
        return;
      }

      if (event.detail >= 2) return;
      actions.handleDataCellMouseDown(ctx, event);
    },
    [
      bodyActionsRef,
      clientToHit,
      resolveCellContext,
      onFieldSortClick,
      onFieldFilterOpen,
      anchorFromHit,
    ],
  );

  const handleDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLCanvasElement>) => {
      const actions = bodyActionsRef.current;
      if (!actions) return;
      const hit = clientToHit(event.clientX, event.clientY);
      if (!hit) return;
      const ctx = resolveCellContext(hit.rowIndex, hit.colIndex);
      if (!ctx) return;
      const isRowSelector =
        ctx.columnId === ROW_NUM_COL_ID || ctx.columnId === TRANSPOSE_FIELD_COL;
      if (isRowSelector) {
        if (actions.handleRowBandDoubleClick) {
          event.preventDefault();
          event.stopPropagation();
          actions.handleRowBandDoubleClick(ctx.rowIndex);
        }
        return;
      }
      if (!ctx.canEdit) return;
      event.preventDefault();
      event.stopPropagation();
      actions.handleDataCellDoubleClick(ctx, anchorFromHit(hit));
    },
    [bodyActionsRef, clientToHit, resolveCellContext, anchorFromHit],
  );

  const handleContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLCanvasElement>) => {
      const actions = bodyActionsRef.current;
      if (!actions) return;
      const hit = clientToHit(event.clientX, event.clientY);
      if (!hit) return;
      const ctx = resolveCellContext(hit.rowIndex, hit.colIndex);
      if (!ctx) return;
      event.preventDefault();
      event.stopPropagation();
      actions.handleDataCellContextMenu(ctx, event);
    },
    [bodyActionsRef, clientToHit, resolveCellContext],
  );

  const handleMouseMove = useCallback(
    (event: ReactMouseEvent<HTMLCanvasElement>) => {
      const hit = clientToHit(event.clientX, event.clientY);
      const next = hit ? { row: hit.rowIndex, col: hit.colIndex } : null;
      const prev = hoverRef.current;
      const changed = prev?.row !== next?.row || prev?.col !== next?.col;
      if (changed) {
        hoverRef.current = next;
        schedulePaint();
      }
      const canvas = canvasRef.current;
      if (canvas) {
        if (hit?.region === "rowResize") {
          canvas.style.cursor = "row-resize";
        } else if (
          hit?.region === "rownum" ||
          hit?.region === "field" ||
          hit?.region === "valueBtn" ||
          hit?.region === "fieldSort" ||
          hit?.region === "fieldFilter"
        ) {
          canvas.style.cursor = "pointer";
        } else {
          canvas.style.cursor = "cell";
        }
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

  const initialHeight = Math.max(
    snapshotInput.defaultRowHeight,
    snapshotInput.tableRows.reduce((sum, row) => {
      return sum + (snapshotInput.rowHeights[row.index] ?? snapshotInput.defaultRowHeight);
    }, 0),
  );
  const initialWidth = snapshotInput.leafColumns.reduce(
    (sum, col) => sum + snapshotInput.resolveColumnWidth(col.id, col.getSize()),
    0,
  );

  return (
    <div
      ref={sizerRef}
      className="db-data-table-canvas-sizer"
      style={{ height: initialHeight, width: Math.max(initialWidth, 1) }}
      aria-hidden
    >
      <canvas
        ref={canvasRef}
        className="db-data-table-canvas"
        onMouseDown={handleMouseDown}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      />
    </div>
  );
});
