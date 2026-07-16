/** 将 dock tab 滚入其横向/纵向滚动容器的可视区域 */

export function findDockTabElement(
  root: ParentNode,
  tabId: string,
): HTMLElement | null {
  const header = root.querySelector<HTMLElement>(
    `.dv-default-tab[data-dock-tab-id="${CSS.escape(tabId)}"]`,
  );
  if (!header) return null;
  return header.closest<HTMLElement>(".dv-tab") ?? header;
}

export function scrollDockTabIntoView(
  root: ParentNode,
  tabId: string,
): boolean {
  const tabEl = findDockTabElement(root, tabId);
  if (!tabEl) return false;

  const scrollParent =
    tabEl.closest<HTMLElement>(".dv-tabs-container") ??
    tabEl.closest<HTMLElement>(".dv-scrollable");

  if (!scrollParent) {
    tabEl.scrollIntoView({ inline: "nearest", block: "nearest" });
    return true;
  }

  const tabRect = tabEl.getBoundingClientRect();
  const parentRect = scrollParent.getBoundingClientRect();
  const pad = 4;

  if (tabRect.left < parentRect.left + pad) {
    scrollParent.scrollLeft -= parentRect.left - tabRect.left + pad;
  } else if (tabRect.right > parentRect.right - pad) {
    scrollParent.scrollLeft += tabRect.right - parentRect.right + pad;
  }

  if (tabRect.top < parentRect.top + pad) {
    scrollParent.scrollTop -= parentRect.top - tabRect.top + pad;
  } else if (tabRect.bottom > parentRect.bottom - pad) {
    scrollParent.scrollTop += tabRect.bottom - parentRect.bottom + pad;
  }

  return true;
}

/** 布局稳定后再滚一次（新建 tab 首帧尺寸可能未就绪） */
export function scheduleScrollDockTabIntoView(
  root: ParentNode | null | undefined,
  tabId: string | null | undefined,
): () => void {
  if (!root || !tabId) return () => {};

  let cancelled = false;
  const run = () => {
    if (cancelled) return;
    scrollDockTabIntoView(root, tabId);
  };

  run();
  const raf1 = requestAnimationFrame(() => {
    run();
    requestAnimationFrame(run);
  });

  return () => {
    cancelled = true;
    cancelAnimationFrame(raf1);
  };
}
