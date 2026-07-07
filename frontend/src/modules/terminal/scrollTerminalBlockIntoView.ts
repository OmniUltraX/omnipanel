const HIGHLIGHT_CLASS = "term-warp-block--scroll-highlight";
const HIGHLIGHT_MS = 1400;

let clearHighlightTimer: ReturnType<typeof setTimeout> | null = null;

function escapeAttr(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function clearHighlightsInPane(pane: HTMLElement | null): void {
  if (!pane) return;
  pane.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach((node) => {
    node.classList.remove(HIGHLIGHT_CLASS);
  });
}

function clearHighlightTimerIfAny(): void {
  if (!clearHighlightTimer) return;
  clearTimeout(clearHighlightTimer);
  clearHighlightTimer = null;
}

/** 在终端 feed 内滚动到指定 block，并短暂高亮。 */
export function scrollTerminalBlockIntoView(sessionId: string, blockId: string): boolean {
  const pane = document.querySelector<HTMLElement>(`[data-pane-id="${escapeAttr(sessionId)}"]`);
  if (!pane) return false;

  const feed = pane.querySelector<HTMLElement>(".term-warp-feed");
  const blockEl = pane.querySelector<HTMLElement>(`[data-block-id="${escapeAttr(blockId)}"]`);
  if (!feed || !blockEl) return false;

  const feedRect = feed.getBoundingClientRect();
  const blockRect = blockEl.getBoundingClientRect();
  const offset = Math.max(12, feed.clientHeight * 0.18);
  const nextTop = feed.scrollTop + (blockRect.top - feedRect.top) - offset;

  feed.scrollTo({ top: Math.max(0, nextTop), behavior: "smooth" });

  const highlightTarget =
    blockEl.closest<HTMLElement>(".term-warp-block") ?? blockEl;

  clearHighlightTimerIfAny();
  clearHighlightsInPane(pane);

  highlightTarget.classList.add(HIGHLIGHT_CLASS);
  clearHighlightTimer = setTimeout(() => {
    highlightTarget.classList.remove(HIGHLIGHT_CLASS);
    clearHighlightTimer = null;
  }, HIGHLIGHT_MS);

  return true;
}

/** 清除某会话 pane 内所有 block 滚动高亮（切 tab / 卸载时可用）。 */
export function clearTerminalBlockHighlights(sessionId?: string): void {
  clearHighlightTimerIfAny();
  if (sessionId) {
    const pane = document.querySelector<HTMLElement>(`[data-pane-id="${escapeAttr(sessionId)}"]`);
    clearHighlightsInPane(pane);
    return;
  }
  document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach((node) => {
    node.classList.remove(HIGHLIGHT_CLASS);
  });
}
