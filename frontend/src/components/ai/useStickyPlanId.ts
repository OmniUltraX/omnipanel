import { useEffect, useRef, useState, type RefObject } from "react";

/** 吸顶栈（用户消息 + TodoList），收集内嵌节点时需排除 */
const STICKY_STACK_SELECTOR = '[data-slot="ai-thread-sticky-stack"]';

/** 吸顶 TodoList 默认/边界高度（px） */
export const DEFAULT_PLAN_STICKY_HEIGHT = 200;
export const MIN_PLAN_STICKY_HEIGHT = 120;
export const MAX_PLAN_STICKY_HEIGHT = 420;
const PLAN_STICKY_HEIGHT_STORAGE_KEY = "omnipanel-ai-plan-sticky-height";

export function clampPlanStickyHeight(height: number): number {
  const viewportCap =
    typeof window !== "undefined"
      ? Math.floor(window.innerHeight * 0.4)
      : MAX_PLAN_STICKY_HEIGHT;
  const max = Math.min(MAX_PLAN_STICKY_HEIGHT, viewportCap);
  return Math.min(max, Math.max(MIN_PLAN_STICKY_HEIGHT, Math.round(height)));
}

export function readStoredPlanStickyHeight(): number {
  if (typeof window === "undefined") return DEFAULT_PLAN_STICKY_HEIGHT;
  try {
    const raw = window.localStorage.getItem(PLAN_STICKY_HEIGHT_STORAGE_KEY);
    if (!raw) return DEFAULT_PLAN_STICKY_HEIGHT;
    const n = Number(raw);
    if (!Number.isFinite(n)) return DEFAULT_PLAN_STICKY_HEIGHT;
    return clampPlanStickyHeight(n);
  } catch {
    return DEFAULT_PLAN_STICKY_HEIGHT;
  }
}

export function writeStoredPlanStickyHeight(height: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      PLAN_STICKY_HEIGHT_STORAGE_KEY,
      String(clampPlanStickyHeight(height)),
    );
  } catch {
    // ignore quota / private mode
  }
}

function isInsideStickyStack(el: Element): boolean {
  return el.closest(STICKY_STACK_SELECTOR) != null;
}

/**
 * 在已滚出视口顶部的元素中，取文档序最后一个 id。
 */
export function resolveLastAboveViewportId(
  viewport: Element,
  els: HTMLElement[],
  getId: (el: HTMLElement) => string | undefined,
): string | null {
  if (els.length === 0) return null;

  const viewportTop = viewport.getBoundingClientRect().top;
  let stickyId: string | null = null;

  for (const el of els) {
    const id = getId(el);
    if (!id) continue;
    if (el.getBoundingClientRect().top < viewportTop) {
      stickyId = id;
    }
  }

  return stickyId;
}

/**
 * 收集对话流内的 PlanView（排除吸顶栈自身），顺序即 DOM 文档序。
 */
export function collectInlinePlanEls(root: ParentNode): HTMLElement[] {
  const all = root.querySelectorAll<HTMLElement>(
    '[data-slot="ai-plan-view"][data-plan-id]',
  );
  const result: HTMLElement[] = [];
  for (const el of all) {
    if (isInsideStickyStack(el)) continue;
    result.push(el);
  }
  return result;
}

/**
 * 收集对话流内的用户消息根节点（排除吸顶栈自身）。
 */
export function collectInlineUserMessageEls(root: ParentNode): HTMLElement[] {
  const all = root.querySelectorAll<HTMLElement>(
    '[data-slot="aui_user-message-root"][data-message-id]',
  );
  const result: HTMLElement[] = [];
  for (const el of all) {
    if (isInsideStickyStack(el)) continue;
    result.push(el);
  }
  return result;
}

/**
 * 解析「当前可视区域上方」的最后一个 TodoList（Plan）。
 *
 * 与终端 AI 卡片吸顶同语义：在已滚出视口顶部的 Plan 中取文档序最后一个。
 */
export function resolveStickyPlanId(
  viewport: Element,
  planEls: HTMLElement[],
): string | null {
  return resolveLastAboveViewportId(viewport, planEls, (el) => el.dataset.planId);
}

/**
 * 解析「当前可视区域上方」的最后一条用户消息。
 */
export function resolveStickyUserMessageId(
  viewport: Element,
  messageEls: HTMLElement[],
): string | null {
  return resolveLastAboveViewportId(
    viewport,
    messageEls,
    (el) => el.dataset.messageId,
  );
}

function findThreadViewport(from: HTMLElement | null): HTMLElement | null {
  const bySlot = document.querySelector<HTMLElement>(
    '[data-slot="aui_thread-viewport"]',
  );
  if (bySlot) {
    const style = getComputedStyle(bySlot);
    if (style.overflowY === "auto" || style.overflowY === "scroll") {
      return bySlot;
    }
  }

  let node: HTMLElement | null = from?.parentElement ?? null;
  while (node && node !== document.body) {
    const style = getComputedStyle(node);
    if (style.overflowY === "auto" || style.overflowY === "scroll") {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

export type ThreadStickyTargets = {
  userMessageId: string | null;
  planId: string | null;
};

const EMPTY_TARGETS: ThreadStickyTargets = {
  userMessageId: null,
  planId: null,
};

/**
 * 随滚动解析应吸顶的用户消息 + Plan（均为视口上方最后一个）。
 * 共用一个 scroll/resize/mutation 监听，避免双挂载打架。
 */
export function useThreadStickyTargets(options: {
  enabled: boolean;
  stickyRef: RefObject<HTMLElement | null>;
  activitySignature?: string;
}): ThreadStickyTargets {
  const { enabled, stickyRef, activitySignature = "" } = options;
  const [targets, setTargets] = useState<ThreadStickyTargets>(EMPTY_TARGETS);
  const targetsRef = useRef<ThreadStickyTargets>(EMPTY_TARGETS);

  useEffect(() => {
    if (!enabled) {
      targetsRef.current = EMPTY_TARGETS;
      setTargets(EMPTY_TARGETS);
      return;
    }

    let viewport: HTMLElement | null = null;
    let rafId = 0;
    let disposed = false;
    let mutationObserver: MutationObserver | null = null;
    let resizeObserver: ResizeObserver | null = null;

    const apply = (next: ThreadStickyTargets) => {
      const prev = targetsRef.current;
      if (
        prev.userMessageId === next.userMessageId &&
        prev.planId === next.planId
      ) {
        return;
      }
      targetsRef.current = next;
      setTargets(next);
    };

    const update = () => {
      rafId = 0;
      if (disposed || !viewport) return;
      apply({
        userMessageId: resolveStickyUserMessageId(
          viewport,
          collectInlineUserMessageEls(viewport),
        ),
        planId: resolveStickyPlanId(viewport, collectInlinePlanEls(viewport)),
      });
    };

    const schedule = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(update);
    };

    const attach = () => {
      if (disposed) return;
      // 避免重复绑定
      if (viewport) {
        schedule();
        return;
      }
      viewport = findThreadViewport(stickyRef.current);
      if (!viewport) return;

      viewport.addEventListener("scroll", schedule, { passive: true });
      window.addEventListener("resize", schedule);
      resizeObserver = new ResizeObserver(schedule);
      resizeObserver.observe(viewport);
      mutationObserver = new MutationObserver(schedule);
      mutationObserver.observe(viewport, { childList: true, subtree: true });
      update();
    };

    const t0 = window.setTimeout(attach, 0);
    const t1 = window.setTimeout(attach, 200);
    const t2 = window.setTimeout(attach, 1000);

    return () => {
      disposed = true;
      window.clearTimeout(t0);
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      if (rafId) cancelAnimationFrame(rafId);
      viewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  }, [activitySignature, enabled, stickyRef]);

  return targets;
}

/**
 * @deprecated 优先用 useThreadStickyTargets；保留兼容单测/旧调用。
 */
export function useStickyPlanId(options: {
  enabled: boolean;
  stickyRef: RefObject<HTMLElement | null>;
  activitySignature?: string;
}): string | null {
  return useThreadStickyTargets(options).planId;
}
