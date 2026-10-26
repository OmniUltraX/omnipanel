import { useEffect, type RefObject } from "react";

const INDICATOR_CLASS = "dock-tab-active-indicator";

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function syncIndicators(root: HTMLElement) {
  const reduced = prefersReducedMotion();
  root.querySelectorAll<HTMLElement>(".dv-tabs-and-actions-container").forEach((header) => {
    const container = header.querySelector<HTMLElement>(".dv-tabs-container");
    if (!container) return;
    const vertical = header.classList.contains("dv-groupview-header-vertical");
    const existing = container.querySelector<HTMLElement>(`:scope > .${INDICATOR_CLASS}`);
    if (vertical) {
      existing?.remove();
      return;
    }

    const dragging = container.querySelector(".dv-tab-dragging, .dv-tab--dragging");
    const active = container.querySelector<HTMLElement>(":scope > .dv-tab.dv-active-tab");
    if (!active || dragging) {
      if (existing) existing.style.opacity = "0";
      return;
    }

    const bar = existing ?? document.createElement("div");
    if (!existing) {
      bar.className = INDICATOR_CLASS;
      bar.setAttribute("aria-hidden", "true");
      container.appendChild(bar);
    }

    const id =
      active.dataset.tabId ||
      active.querySelector<HTMLElement>("[data-dock-tab-id]")?.dataset.dockTabId ||
      "";
    const width = active.offsetWidth;
    const left = active.offsetLeft;
    if (width < 1) {
      bar.style.opacity = "0";
      return;
    }

    const containerRect = container.getBoundingClientRect();
    const tabRect = active.getBoundingClientRect();
    const fullyVisible =
      tabRect.left >= containerRect.left - 1 && tabRect.right <= containerRect.right + 1;
    const previousId = bar.dataset.tabId ?? "";
    const leftKey = String(left);
    const switching = previousId.length > 0 && previousId !== id;
    if (
      previousId === id &&
      bar.dataset.left === leftKey &&
      bar.style.width === `${width}px`
    ) {
      bar.style.opacity = "1";
      return;
    }
    bar.dataset.tabId = id;
    bar.dataset.left = leftKey;
    bar.dataset.snap = switching && fullyVisible && !reduced ? "0" : "1";
    bar.style.width = `${width}px`;
    bar.style.transform = `translate3d(${left}px, 0, 0)`;
    bar.style.opacity = "1";
  });
}

/** 横向标签栏上的激活条。只动画 transform / width，竖排侧栏保持原样。 */
export function useDockTabActiveIndicator(
  rootRef: RefObject<HTMLElement | null>,
  enabled: boolean,
) {
  useEffect(() => {
    if (!enabled) return;
    const root = rootRef.current;
    if (!root) return;

    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => syncIndicators(root));
    };

    schedule();
    const resize = new ResizeObserver(schedule);
    resize.observe(root);
    root.querySelectorAll(".dv-tabs-container").forEach((node) => resize.observe(node));
    const mutations = new MutationObserver(schedule);
    mutations.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class"],
    });

    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      root.querySelectorAll(`.${INDICATOR_CLASS}`).forEach((node) => node.remove());
    };
  }, [enabled, rootRef]);
}
