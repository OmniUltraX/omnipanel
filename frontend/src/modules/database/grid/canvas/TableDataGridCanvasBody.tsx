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
import { measureHeaderColumnGeometry } from "../tableDataGridLayout";
import { buildGridSnapshotBundle, type BuildGridSnapshotInput } from "./buildGridSnapshot";
import { drawGridBody } from "./drawGridBody";
import { cellViewportRect, hitTestGrid, isPinnedDrawColumn } from "./gridGeometry";
import { invalidateCanvasGridThemeCache, measureHeaderHeight, readGridTheme } from "./readGridTheme";
import type {
  CellViewportRect,
  GridHitResult,
  GridRenderSnapshot,
  GridThemeTokens,
} from "./gridRenderTypes";

/**
 * 用可见表头单元格锚定 Canvas 横向偏移，消除滚到最右侧时的亚像素/总宽差导致的错位。
 */
function resolveAlignedScrollLeft(
  wrap: HTMLElement,
  canvas: HTMLCanvasElement,
  snapshot: GridRenderSnapshot,
  scrollLeft: number,
): number {
  const canvasLeft = canvas.getBoundingClientRect().left;
  const pinnedWidth = snapshot.columns.reduce(
    (sum, col) => (isPinnedDrawColumn(col) ? sum + col.width : sum),
    0,
  );
  for (let i = 0; i < snapshot.columns.length; i += 1) {
    const col = snapshot.columns[i]!;
    if (isPinnedDrawColumn(col)) continue;
    // 优先选视口内、且不被固定列遮住的列
    const screenX = col.x - scrollLeft;
    if (screenX + col.width <= pinnedWidth || screenX >= canvas.clientWidth) continue;
    const th = wrap.querySelector(`th[data-col-id="${CSS.escape(col.id)}"]`);
    if (!(th instanceof HTMLElement)) continue;
    const expectedScreenX = th.getBoundingClientRect().left - canvasLeft;
    // col.x - alignedScrollLeft = expectedScreenX
    return col.x - expectedScreenX;
  }
  // 回退：任意非固定列表头
  for (let i = 0; i < snapshot.columns.length; i += 1) {
    const col = snapshot.columns[i]!;
    if (isPinnedDrawColumn(col)) continue;
    const th = wrap.querySelector(`th[data-col-id="${CSS.escape(col.id)}"]`);
    if (!(th instanceof HTMLElement)) continue;
    const expectedScreenX = th.getBoundingClientRect().left - canvasLeft;
    return col.x - expectedScreenX;
  }
  return scrollLeft;
}

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
  /**
   * 若提供，rebuild 时优先用此 ref 的行（React 外 rowCache 灌数，避免每片 setState）。
   */
  tableRowsRef?: MutableRefObject<BuildGridSnapshotInput["tableRows"]>;
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
    tableRowsRef,
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
  /** 仅结构/测量变化时全量 rebuild；滚动与 hover 只改 hover 字段再 draw */
  const structureDirtyRef = useRef(true);
  /**
   * 首帧跳过表头 DOM 测量（N 次 querySelector + offset* 会强制 layout）。
   * 先用逻辑列宽画出内容，次帧再测量对齐表头（对齐 dbx：先可见再精修）。
   */
  const skipHeaderMeasureRef = useRef(true);
  /**
   * 测量结果 cache：列 id 签名没变时复用，避免每次 rebuild 都做 N 次 offsetWidth（强制 reflow）。
   * 列宽拖拽会单独设 dragColumnWidth 覆盖，不依赖 measured；只有列结构变化才需要重测。
   */
  const measuredCacheRef = useRef<{ signature: string; result: { columns: { x: number; width: number }[]; totalWidth: number } | null } | null>(null);
  /** 对齐 dbx：滚动中不画 hover，减每帧开销 */
  const isScrollingRef = useRef(false);
  const scrollIdleTimerRef = useRef<number | null>(null);
  const scrollTopRef = useRef(0);
  const scrollLeftRef = useRef(0);
  /** resolveAlignedScrollLeft 缓存：-1 表示未计算。仅列结构变化时重算。 */
  const alignedScrollLeftRef = useRef(-1);

  const rebuildSnapshot = useCallback(() => {
    const wrap = scrollElementRef.current;
    const leafColumns = snapshotInputRef.current.leafColumns;
    const allowMeasure = !skipHeaderMeasureRef.current;
    // 列 id + 逻辑宽度签名：列结构或列宽变化才重测，避免每次 rebuild 都做 N 次 offsetWidth（强制 reflow）
    const signature = leafColumns.map((col) => `${col.id}:${col.getSize()}`).join("\u0000");
    const cached = measuredCacheRef.current;
    let measured: { columns: { x: number; width: number }[]; totalWidth: number } | null = null;
    if (allowMeasure && wrap) {
      if (cached && cached.signature === signature) {
        measured = cached.result;
      } else {
        measured = measureHeaderColumnGeometry(
          wrap,
          leafColumns.map((col) => col.id),
        );
        measuredCacheRef.current = { signature, result: measured };
      }
    }
    if (skipHeaderMeasureRef.current) {
      skipHeaderMeasureRef.current = false;
    }
    const bundle = buildGridSnapshotBundle({
      ...snapshotInputRef.current,
      tableRows: tableRowsRef?.current ?? snapshotInputRef.current.tableRows,
      dragRange: dragRangeRef.current,
      dragRowHeight: dragRowHeightRef.current,
      dragColumnWidth: dragColumnWidthRef.current,
      measuredColumnGeometry: measured?.columns ?? null,
      measuredTotalWidth: measured?.totalWidth ?? null,
      hoverRow: hoverRef.current?.row ?? null,
      hoverCol: hoverRef.current?.col ?? null,
    });
    snapshotRef.current = bundle.snapshot;
    rowOffsetsRef.current = bundle.rowOffsets;
    structureDirtyRef.current = false;
    if (sizerRef.current) {
      sizerRef.current.style.height = `${bundle.snapshot.totalHeight}px`;
      // 与表头 table 同宽，保证 scrollWidth / maxScrollLeft 一致
      sizerRef.current.style.width = `${Math.max(bundle.snapshot.totalWidth, 1)}px`;
    }
    if (wrap && measured && measured.totalWidth > 0) {
      const table = wrap.querySelector<HTMLElement>("table.db-data-table");
      // 拖拽中由表头增量维护 width，避免覆盖
      if (table && !table.dataset.canvasDragTableWidth) {
        table.style.width = `${measured.totalWidth}px`;
      }
    }
    return bundle;
  }, [dragRangeRef, dragRowHeightRef, dragColumnWidthRef, scrollElementRef, tableRowsRef]);

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = scrollElementRef.current;
    if (!canvas || !wrap) return;

    let snapshot: GridRenderSnapshot;
    let rowOffsets: number[];
    if (structureDirtyRef.current || !snapshotRef.current) {
      const bundle = rebuildSnapshot();
      snapshot = bundle.snapshot;
      rowOffsets = bundle.rowOffsets;
    } else {
      snapshot = snapshotRef.current;
      rowOffsets = rowOffsetsRef.current;
      if (isScrollingRef.current) {
        snapshot.hoverRow = null;
        snapshot.hoverCol = null;
      } else {
        snapshot.hoverRow = hoverRef.current?.row ?? null;
        snapshot.hoverCol = hoverRef.current?.col ?? null;
      }
    }
    // 仅结构变化时重新测量表头高度（getBoundingClientRect 强制 layout），
    // 非结构变化（滚动/hover）复用缓存值
    if (structureDirtyRef.current || headerHeightRef.current === 0) {
      const headerHeight = measureHeaderHeight(wrap);
      headerHeightRef.current = headerHeight;
      wrap.style.setProperty("--db-grid-header-height", `${headerHeight}px`);
    }
    const headerHeight = headerHeightRef.current || 28;

    const rawScrollTop = wrap.scrollTop;
    const rawScrollLeft = wrap.scrollLeft;
    scrollTopRef.current = rawScrollTop;
    // 行号表头用 transform 跟随横滚（避免 sticky left 热区挡 canvas）
    wrap.style.setProperty("--db-grid-rownum-tx", `${rawScrollLeft}px`);

    const cssWidth = Math.max(1, wrap.clientWidth);
    const fullCssHeight = Math.max(1, wrap.clientHeight - headerHeight);
    // 滚过内容底部时（sticky table 占位与 headerHeight 微差导致 scrollHeight 偏大），
    // 缩短 canvas 高度使底部对齐内容底部，避免画出无行数据的空白区域。
    const cssHeight = Math.min(fullCssHeight, Math.max(1, snapshot.totalHeight - rawScrollTop));
    const dpr = window.devicePixelRatio || 1;
    const nextW = Math.floor(cssWidth * dpr);
    const nextH = Math.floor(cssHeight * dpr);

    if (canvas.width !== nextW || canvas.height !== nextH) {
      canvas.width = nextW;
      canvas.height = nextH;
    }
    // 不用 sticky left：超宽 sizer 内横向 sticky 在 WebView 常失效，行号会被滚出视口。
    // 改为跟滚动偏移绝对定位，保证画布始终盖住视口；固定列由 draw 层钉在 screenX=0。
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    canvas.style.left = `${rawScrollLeft}px`;
    canvas.style.top = `${rawScrollTop}px`;

    // resolveAlignedScrollLeft 内部循环 querySelector + getBoundingClientRect 强制 layout，
    // 但对齐结果只取决于列 DOM 位置（列结构变化时才变），滚动时表头只做 transform 偏移。
    // 仅 structureDirty 时重新计算，非结构变化直接用上次缓存的 alignedScrollLeft。
    let alignedScrollLeft: number;
    if (structureDirtyRef.current || alignedScrollLeftRef.current === -1) {
      alignedScrollLeft = resolveAlignedScrollLeft(wrap, canvas, snapshot, rawScrollLeft);
      alignedScrollLeftRef.current = alignedScrollLeft;
    } else {
      alignedScrollLeft = alignedScrollLeftRef.current;
    }
    scrollLeftRef.current = alignedScrollLeft;

    themeRef.current ??= readGridTheme(wrap);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    drawGridBody({
      ctx,
      snapshot,
      theme: themeRef.current,
      rowOffsets,
      scrollLeft: alignedScrollLeft,
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

  const markStructureDirtyAndPaint = useCallback(() => {
    structureDirtyRef.current = true;
    schedulePaint();
  }, [schedulePaint]);

  useLayoutEffect(() => {
    // 数据/列结构变化：先逻辑宽度快画，再预约一次带测量的精修
    skipHeaderMeasureRef.current = true;
    markStructureDirtyAndPaint();
    const raf = requestAnimationFrame(() => {
      structureDirtyRef.current = true;
      schedulePaint();
    });
    return () => cancelAnimationFrame(raf);
  }, [snapshotInput, markStructureDirtyAndPaint, schedulePaint]);

  useEffect(() => {
    const wrap = scrollElementRef.current;
    if (!wrap) return;

    const onScroll = () => {
      scrollTopRef.current = wrap.scrollTop;
      scrollLeftRef.current = wrap.scrollLeft;
      // 表头行号 transform 同步到滚动帧，避免等 rAF paint 才跟上
      wrap.style.setProperty("--db-grid-rownum-tx", `${wrap.scrollLeft}px`);
      if (!isScrollingRef.current) {
        isScrollingRef.current = true;
        hoverRef.current = null;
      }
      if (scrollIdleTimerRef.current != null) {
        window.clearTimeout(scrollIdleTimerRef.current);
      }
      scrollIdleTimerRef.current = window.setTimeout(() => {
        isScrollingRef.current = false;
        scrollIdleTimerRef.current = null;
        schedulePaint();
      }, 120);
      schedulePaint();
    };
    // 捕获阶段确保一定收到滚动（部分 WebView 上冒泡可能被吃掉）
    wrap.addEventListener("scroll", onScroll, { passive: true, capture: true });

    const ro = new ResizeObserver(() => {
      themeRef.current = null;
      measuredCacheRef.current = null; // 视口变化可能影响列宽，失效测量 cache
      markStructureDirtyAndPaint();
    });
    ro.observe(wrap);

    const mo = new MutationObserver(() => {
      invalidateCanvasGridThemeCache();
      themeRef.current = null;
      markStructureDirtyAndPaint();
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
      if (scrollIdleTimerRef.current != null) {
        window.clearTimeout(scrollIdleTimerRef.current);
        scrollIdleTimerRef.current = null;
      }
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [scrollElementRef, schedulePaint, markStructureDirtyAndPaint]);

  const clientToHit = useCallback(
    (clientX: number, clientY: number): GridHitResult | null => {
      const canvas = canvasRef.current;
      const wrap = scrollElementRef.current;
      if (!snapshotRef.current) {
        rebuildSnapshot();
      }
      const snap = snapshotRef.current;
      if (!canvas || !wrap || !snap) return null;

      // 直接用 canvas 的实际屏幕位置计算视口坐标，
      // 避免 wrapRect.top + headerHeight 推算与 table.offsetHeight 微差导致的 hitTest 偏移
      const canvasRect = canvas.getBoundingClientRect();
      const localX = clientX - canvasRect.left;
      const localY = clientY - canvasRect.top;
      const viewW = canvasRect.width;
      const viewH = canvasRect.height;
      if (localX < 0 || localY < 0 || localX > viewW || localY > viewH) {
        return null;
      }

      const scrollLeft =
        Math.abs(scrollLeftRef.current - wrap.scrollLeft) < 2
          ? scrollLeftRef.current
          : resolveAlignedScrollLeft(wrap, canvas, snap, wrap.scrollLeft);

      return hitTestGrid(
        snap,
        rowOffsetsRef.current,
        localX,
        localY,
        scrollLeft,
        wrap.scrollTop,
      );
    },
    [rebuildSnapshot, scrollElementRef],
  );

  const getCellViewportRect = useCallback(
    (rowIndex: number, colIndex: number): CellViewportRect | null => {
      const wrap = scrollElementRef.current;
      const canvas = canvasRef.current;
      const snapshot = snapshotRef.current ?? rebuildSnapshot().snapshot;
      if (!wrap || !canvas) return null;
      const alignedScrollLeft = resolveAlignedScrollLeft(
        wrap,
        canvas,
        snapshot,
        wrap.scrollLeft,
      );
      return cellViewportRect(
        snapshot,
        rowOffsetsRef.current,
        rowIndex,
        colIndex,
        alignedScrollLeft,
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
      invalidate: markStructureDirtyAndPaint,
    }),
    [clientToHit, getCellViewportRect, rebuildSnapshot, markStructureDirtyAndPaint, scrollElementRef],
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
      // 对齐 dbx：滚动中不做 hitTest/hover 重绘
      if (isScrollingRef.current) return;
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
