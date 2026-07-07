import { useEffect, useRef, useState, type RefObject } from "react";
import type { TerminalBlock } from "../../stores/blocksStore";
import { findLastAiBlockId } from "./terminalAiDock";

type ListBlockEntry = {
  blockId: string;
  rect: DOMRect;
};

/** 向下切换到较新 AI 前，其 segment 顶部需进入视口该线以上（避免边界抖动） */
export const STICKY_HANDOFF_INSET_PX = 140;

/** 列表子节点可能是 Fragment 展开的 sentinel + outer，block id 在嵌套层 */
export function collectListBlockEntries(list: HTMLElement): ListBlockEntry[] {
  const entries: ListBlockEntry[] = [];
  for (const child of list.children) {
    if (!(child instanceof HTMLElement)) continue;
    const blockId =
      child.dataset.blockId ??
      child.querySelector<HTMLElement>("[data-block-id]")?.dataset.blockId;
    if (!blockId) continue;
    entries.push({ blockId, rect: child.getBoundingClientRect() });
  }
  return entries;
}

function aiBlockIndex(visibleBlocks: TerminalBlock[], blockId: string): number {
  return visibleBlocks.findIndex((block) => block.id === blockId && block.kind === "ai");
}

/**
 * 吸顶 AI 切换滞后：向下滚到较新 AI 时，需其 segment 明显进入视口才切换，
 * 避免「吸顶态 ↔ 文档流」布局来回跳变引发 ResizeObserver 正反馈抽搐。
 */
export function applyStickyHandoff(
  currentId: string | null,
  computedId: string | null,
  visibleBlocks: TerminalBlock[],
  entries: ListBlockEntry[],
  container: HTMLElement,
): string | null {
  if (!computedId) return currentId;
  if (!currentId || currentId === computedId) return computedId;

  const currentIdx = aiBlockIndex(visibleBlocks, currentId);
  const computedIdx = aiBlockIndex(visibleBlocks, computedId);
  if (currentIdx < 0 || computedIdx < 0) return computedId;

  // 向上滚回较早 AI：立即切换
  if (computedIdx < currentIdx) return computedId;

  const entry = entries.find((item) => item.blockId === computedId);
  if (!entry) return currentId;

  const containerRect = container.getBoundingClientRect();
  const handoffLine = containerRect.bottom - STICKY_HANDOFF_INSET_PX;
  if (entry.rect.top > handoffLine) {
    return currentId;
  }

  return computedId;
}

/**
 * 根据 Feed 滚动视口，解析「当前展示内容上方」的最后一条 AI 块。
 *
 * 取视口内最靠下的可见块为锚点，在其之前的时间线里找最后一条 AI。
 * 例：[AI1, shell, AI2, shell] 滚到底时锚点为底部 shell → 吸顶 AI2；
 * 向上滚到 AI1 区域时锚点可能是中间 shell → 吸顶 AI1。
 */
export function resolveStickyAiBlockId(
  container: HTMLElement,
  list: HTMLElement,
  visibleBlocks: TerminalBlock[],
): string | null {
  const containerRect = container.getBoundingClientRect();
  const viewportTop = containerRect.top;
  const viewportBottom = containerRect.bottom;

  const entries = collectListBlockEntries(list);
  if (entries.length === 0) return null;

  let anchorIndex = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const { rect } = entries[i];
    if (rect.top < viewportBottom && rect.bottom > viewportTop) {
      anchorIndex = i;
      break;
    }
  }
  if (anchorIndex < 0) {
    anchorIndex = entries.length - 1;
  }

  let stickyAiBlockId: string | null = null;
  for (let i = 0; i <= anchorIndex; i++) {
    const id = entries[i]?.blockId;
    if (!id) continue;
    const block = visibleBlocks.find((entry) => entry.id === id);
    if (block?.kind === "ai") stickyAiBlockId = id;
  }
  return stickyAiBlockId;
}

/**
 * 解析吸顶 AI：有展开块时锁定到该块，避免滚动边界反复切换吸顶态。
 * 无展开块时再按视口锚点解析。
 */
export function resolveStickyAiBlockIdWithExpanded(
  container: HTMLElement,
  list: HTMLElement,
  visibleBlocks: TerminalBlock[],
  expandedAiBlockId: string | null,
): string | null {
  if (
    expandedAiBlockId &&
    visibleBlocks.some((block) => block.id === expandedAiBlockId && block.kind === "ai")
  ) {
    return expandedAiBlockId;
  }
  return resolveStickyAiBlockId(container, list, visibleBlocks);
}

export function useStickyAiBlockId(
  scrollRef: RefObject<HTMLElement | null>,
  listRef: RefObject<HTMLElement | null>,
  visibleBlocks: TerminalBlock[],
  activitySignature = "",
  expandedAiBlockId: string | null = null,
): string | null {
  const fallbackId = findLastAiBlockId(visibleBlocks);
  const expandedStickyId =
    expandedAiBlockId &&
    visibleBlocks.some((block) => block.id === expandedAiBlockId && block.kind === "ai")
      ? expandedAiBlockId
      : null;

  const [stickyAiBlockId, setStickyAiBlockId] = useState<string | null>(
    expandedStickyId ?? fallbackId,
  );
  const stickyRef = useRef<string | null>(expandedStickyId ?? fallbackId);

  useEffect(() => {
    const next = expandedStickyId ?? fallbackId;
    stickyRef.current = next;
    setStickyAiBlockId(next);
  }, [expandedStickyId, fallbackId]);

  useEffect(() => {
    if (expandedStickyId) {
      return;
    }

    const container = scrollRef.current;
    const list = listRef.current;
    if (!container || !list) {
      stickyRef.current = fallbackId;
      setStickyAiBlockId(fallbackId);
      return;
    }

    let rafId = 0;
    let disposed = false;

    const update = () => {
      rafId = 0;
      if (disposed) return;

      const entries = collectListBlockEntries(list);
      const computed = resolveStickyAiBlockId(container, list, visibleBlocks) ?? fallbackId;
      const next =
        applyStickyHandoff(stickyRef.current, computed, visibleBlocks, entries, container) ??
        fallbackId;

      stickyRef.current = next;
      setStickyAiBlockId((prev) => (prev === next ? prev : next));
    };

    const schedule = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(update);
    };

    update();
    container.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);

    const observer = new ResizeObserver(schedule);
    observer.observe(container);

    return () => {
      disposed = true;
      if (rafId) cancelAnimationFrame(rafId);
      container.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      observer.disconnect();
    };
  }, [activitySignature, expandedStickyId, fallbackId, listRef, scrollRef, visibleBlocks]);

  return expandedStickyId ?? stickyAiBlockId ?? fallbackId;
}
