/** 按文档顺序，用前面更浅层级的真实行高累加出吸顶偏移。 */
export function stickyOffsetTops(rows: { depth: number; height: number }[]): number[] {
  const stack: { depth: number; height: number }[] = [];
  const tops: number[] = [];
  for (const row of rows) {
    while (stack.length > 0 && stack[stack.length - 1]!.depth >= row.depth) {
      stack.pop();
    }
    let top = 0;
    for (const item of stack) top += item.height;
    tops.push(top);
    stack.push(row);
  }
  return tops;
}

type StickyRootEntry = {
  rows: Set<HTMLElement>;
  observer: ResizeObserver;
  mutations: MutationObserver;
  scroller: HTMLElement;
  onScroll: () => void;
  raf: number;
};

const roots = new Map<HTMLElement, StickyRootEntry>();

function scrollTarget(root: HTMLElement): HTMLElement {
  const overflow = getComputedStyle(root).overflowY;
  if (overflow === "auto" || overflow === "scroll" || overflow === "overlay") return root;
  let current = root.parentElement;
  while (current) {
    const overflowY = getComputedStyle(current).overflowY;
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") return current;
    current = current.parentElement;
  }
  return root;
}

function stickyNodes(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(".sidebar-tree-node--sticky")].filter(
    (node) => !node.closest(".sidebar-tree-sticky-row"),
  );
}

/** 父级已经滚到吸顶线之上，且本行正贴在那条线上，才算吸住。 */
function markStuckRows(root: HTMLElement) {
  const scroller = scrollTarget(root);
  const portTop = scroller.getBoundingClientRect().top;
  for (const node of stickyNodes(root)) {
    const stickyTop = Number.parseFloat(node.style.top || "0") || 0;
    const line = portTop + stickyTop;
    const parentTop = node.parentElement?.getBoundingClientRect().top ?? line;
    const rowTop = node.getBoundingClientRect().top;
    const stuck = parentTop < line - 0.5 && Math.abs(rowTop - line) < 1.5;
    node.classList.toggle("is-stuck", stuck);
  }
}

function layoutSidebarSticky(root: HTMLElement) {
  const nodes = stickyNodes(root);
  const measured = nodes.map((node) => ({
    node,
    depth: Number(node.style.getPropertyValue("--tree-depth") || "0"),
    height: node.offsetHeight,
  }));
  const tops = stickyOffsetTops(measured);
  measured.forEach((row, index) => {
    const top = `${tops[index] ?? 0}px`;
    if (row.node.style.top !== top) row.node.style.top = top;
  });
  markStuckRows(root);
}

function schedule(root: HTMLElement) {
  const entry = roots.get(root);
  if (!entry || entry.raf) return;
  entry.raf = requestAnimationFrame(() => {
    const current = roots.get(root);
    if (!current) return;
    current.raf = 0;
    layoutSidebarSticky(root);
  });
}

export function refreshSidebarStickyRoot(root: HTMLElement) {
  layoutSidebarSticky(root);
}

/** 结构树的吸顶在外层定高行上，用 CSS 偏移，不在这里改。 */
export function bindSidebarStickyRow(row: HTMLElement): () => void {
  if (row.closest(".sidebar-tree-sticky-row")) return () => {};
  const root = row.closest(".sidebar-tree-sticky");
  if (!(root instanceof HTMLElement)) return () => {};

  let entry = roots.get(root);
  if (!entry) {
    const scroller = scrollTarget(root);
    const created: StickyRootEntry = {
      rows: new Set(),
      raf: 0,
      scroller,
      onScroll: () => schedule(root),
      observer: new ResizeObserver(() => schedule(root)),
      mutations: new MutationObserver(() => schedule(root)),
    };
    created.observer.observe(root);
    created.mutations.observe(root, { childList: true, subtree: true });
    scroller.addEventListener("scroll", created.onScroll, { passive: true });
    entry = created;
    roots.set(root, entry);
  }
  entry.rows.add(row);
  entry.observer.observe(row);
  layoutSidebarSticky(root);

  return () => {
    const current = roots.get(root);
    if (!current) return;
    current.rows.delete(row);
    current.observer.unobserve(row);
    row.style.top = "";
    row.classList.remove("is-stuck");
    if (current.rows.size === 0) {
      current.observer.disconnect();
      current.mutations.disconnect();
      current.scroller.removeEventListener("scroll", current.onScroll);
      if (current.raf) cancelAnimationFrame(current.raf);
      roots.delete(root);
    } else {
      schedule(root);
    }
  };
}
