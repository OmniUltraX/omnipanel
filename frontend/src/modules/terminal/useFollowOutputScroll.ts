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

  const scrollToEnd = useCallback(() => {
    const el = containerRef.current;
    if (!el || !followRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [containerRef]);

  const scheduleScrollToEnd = useCallback(() => {
    cancelAnimationFrame(scrollRafRef.current);
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = 0;
      if (settleUntilRef.current > performance.now()) return;
      scrollToEnd();
    });
  }, [scrollToEnd]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !enabled) return;

    const syncPinned = () => {
      const scrollHeight = el.scrollHeight;
      followRef.current = isScrollPinnedToBottom(
        el,
        pinThresholdPx,
        lastScrollHeightRef.current,
      );
      lastScrollHeightRef.current = scrollHeight;
    };

    syncPinned();
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
    let observer: ResizeObserver | null = null;

    const attachObserver = () => {
      const content =
        container.querySelector<HTMLElement>(".aui_message-group") ??
        container.querySelector<HTMLElement>(".term-warp-ai-thread-root") ??
        (container.firstElementChild instanceof HTMLElement ? container.firstElementChild : null);
      if (!content || content === observed) return;
      observer?.disconnect();
      observed = content;
      observer = new ResizeObserver(() => {
        if (!followRef.current) return;
        scheduleScrollToEnd();
      });
      observer.observe(content);
    };

    attachObserver();
    const mutation = new MutationObserver(attachObserver);
    mutation.observe(container, { childList: true, subtree: true });

    return () => {
      mutation.disconnect();
      observer?.disconnect();
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
