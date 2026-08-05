import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

export const FOLLOW_OUTPUT_PIN_THRESHOLD_PX = 48;

export function isScrollPinnedToBottom(
  el: HTMLElement,
  thresholdPx: number,
  lastScrollHeight: number,
): boolean {
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
  if (distance > thresholdPx) return false;
  if (lastScrollHeight - el.scrollHeight > 120 && distance <= thresholdPx) {
    return false;
  }
  return true;
}

export type UseFollowOutputScrollOptions = {
  enabled?: boolean;
  /** 内容变化签名，仅在贴底时触发跟随滚底 */
  contentSignature?: string;
  pinThresholdPx?: number;
  /** enabled 刚变为 true 时跳过的帧数（吸顶切换过渡） */
  settleFrames?: number;
};

/**
 * 贴底跟随滚动：合并 rAF、尊重用户上滚，避免流式输出时频繁 scrollTop 导致闪烁。
 * 侧栏 Thread 由 assistant-ui Viewport 管理；终端内嵌卡片用此 hook。
 */
export function useFollowOutputScroll(
  containerRef: React.RefObject<HTMLElement | null>,
  {
    enabled = true,
    contentSignature = "",
    pinThresholdPx = FOLLOW_OUTPUT_PIN_THRESHOLD_PX,
    settleFrames = 1,
  }: UseFollowOutputScrollOptions = {},
) {
  const followRef = useRef(true);
  const lastScrollHeightRef = useRef(0);
  const scrollRafRef = useRef(0);
  const settleUntilRef = useRef(0);
  const wasEnabledRef = useRef(false);
  // 程序触发滚动时间窗口标记（替代微任务，更可靠地覆盖延迟 scroll 事件）
  const programmaticScrollUntilRef = useRef(0);

  // 立即滚到底（同步方式）
  const scrollToEnd = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 0) return;
    if (Math.abs(el.scrollTop - max) <= 2) {
      lastScrollHeightRef.current = el.scrollHeight;
      return;
    }
    programmaticScrollUntilRef.current = performance.now() + 150;
    el.scrollTop = el.scrollHeight;
    lastScrollHeightRef.current = el.scrollHeight;
  }, [containerRef]);

  const scheduleScrollToEnd = useCallback(() => {
    if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = 0;
      if (settleUntilRef.current > performance.now()) return;
      if (followRef.current) {
        scrollToEnd();
      }
    });
  }, [scrollToEnd]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !enabled) return;

    const syncPinned = () => {
      if (el.clientHeight === 0) return;
      // 程序触发的滚动不更新 followRef
      if (performance.now() < programmaticScrollUntilRef.current) return;
      const scrollHeight = el.scrollHeight;
      followRef.current = isScrollPinnedToBottom(
        el,
        pinThresholdPx,
        lastScrollHeightRef.current,
      );
      lastScrollHeightRef.current = scrollHeight;
    };

    // 初始同步（不更新 followRef，只记录 scrollHeight）
    if (el.clientHeight > 0) {
      lastScrollHeightRef.current = el.scrollHeight;
    }
    el.addEventListener("scroll", syncPinned, { passive: true });
    return () => el.removeEventListener("scroll", syncPinned);
  }, [containerRef, enabled, pinThresholdPx]);

  useLayoutEffect(() => {
    if (!enabled) {
      wasEnabledRef.current = false;
      return;
    }

    const justEnabled = !wasEnabledRef.current;
    wasEnabledRef.current = true;

    if (justEnabled && settleFrames > 0) {
      settleUntilRef.current = performance.now() + settleFrames * 16;
      return;
    }

    if (followRef.current) {
      scheduleScrollToEnd();
    }
  }, [enabled, contentSignature, scheduleScrollToEnd, settleFrames]);

  useEffect(() => {
    if (!enabled) return;
    const container = containerRef.current;
    if (!container) return;

    let observed: HTMLElement | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let mutationObserver: MutationObserver | null = null;

    const scheduleIfFollowing = () => {
      if (!followRef.current) return;
      scheduleScrollToEnd();
    };

    const attachObserver = () => {
      const content =
        container.querySelector<HTMLElement>(".aui_message-group") ??
        container.querySelector<HTMLElement>(".term-warp-ai-thread-root") ??
        (container.firstElementChild instanceof HTMLElement ? container.firstElementChild : null);
      if (!content || content === observed) return;
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      observed = content;
      resizeObserver = new ResizeObserver(() => {
        scheduleIfFollowing();
      });
      resizeObserver.observe(content);
      mutationObserver = new MutationObserver(() => {
        scheduleIfFollowing();
      });
      mutationObserver.observe(content, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    };

    attachObserver();
    const mo = new MutationObserver(attachObserver);
    mo.observe(container, { childList: true, subtree: true });

    return () => {
      mo.disconnect();
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  }, [containerRef, enabled, scheduleScrollToEnd]);

  useEffect(
    () => () => {
      cancelAnimationFrame(scrollRafRef.current);
    },
    [],
  );

  return { scheduleScrollToEnd, scrollToEnd, followRef };
}
