export type SplitDirection = "horizontal" | "vertical";

export type SplitNode = {
  id: string;
  type: "pane";
  paneId: string;
};

export type SplitContainer = {
  id: string;
  type: "split";
  direction: SplitDirection;
  children: Array<SplitNode | SplitContainer>;
  sizes: number[];
};

export type LayoutNode = SplitNode | SplitContainer;

let splitNodeCounter = 0;

export function generateSplitId(): string {
  return `split-${splitNodeCounter++}`;
}

export function isSplitContainer(node: LayoutNode): node is SplitContainer {
  return node.type === "split";
}

export function findPaneNode(tree: LayoutNode, paneId: string): SplitNode | null {
  if (!isSplitContainer(tree)) {
    return tree.paneId === paneId ? tree : null;
  }
  for (const child of tree.children) {
    const found = findPaneNode(child, paneId);
    if (found) return found;
  }
  return null;
}

export function findParentOfPane(
  tree: LayoutNode,
  paneId: string,
): SplitContainer | null {
  if (!isSplitContainer(tree)) return null;
  for (const child of tree.children) {
    if (!isSplitContainer(child) && child.paneId === paneId) {
      return tree;
    }
    const found = findParentOfPane(child, paneId);
    if (found) return found;
  }
  return null;
}

export function updateNode(
  tree: LayoutNode,
  nodeId: string,
  updater: (node: LayoutNode) => LayoutNode,
): LayoutNode {
  if (tree.id === nodeId) return updater(tree);
  if (isSplitContainer(tree)) {
    return {
      ...tree,
      children: tree.children.map((child) => updateNode(child, nodeId, updater)),
    };
  }
  return tree;
}

export function updatePaneNode(
  tree: LayoutNode,
  paneId: string,
  updater: (node: SplitNode) => LayoutNode,
): LayoutNode {
  if (!isSplitContainer(tree)) {
    return tree.paneId === paneId ? updater(tree) : tree;
  }
  let changed = false;
  const children = tree.children.map((child) => {
    const next = updatePaneNode(child, paneId, updater);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...tree, children } : tree;
}

export function removePaneNode(tree: LayoutNode, paneId: string): LayoutNode {
  if (!isSplitContainer(tree)) {
    return tree;
  }

  const nextChildren: LayoutNode[] = [];
  const keptSizes: number[] = [];

  tree.children.forEach((child, index) => {
    if (!isSplitContainer(child) && child.paneId === paneId) {
      return;
    }
    const nextChild = isSplitContainer(child)
      ? removePaneNode(child, paneId)
      : child;
    nextChildren.push(nextChild);
    keptSizes.push(tree.sizes[index] ?? 0);
  });

  if (nextChildren.length === tree.children.length) {
    return {
      ...tree,
      children: tree.children.map((child) =>
        isSplitContainer(child) ? removePaneNode(child, paneId) : child,
      ),
    };
  }

  if (nextChildren.length === 1) {
    return nextChildren[0];
  }

  return {
    ...tree,
    children: nextChildren,
    sizes: normalizeSizes(keptSizes, nextChildren.length),
  };
}

export function createPaneNode(paneId: string): SplitNode {
  return { id: paneId, type: "pane", paneId };
}

export function normalizeSizes(sizes: number[], count: number): number[] {
  if (sizes.length !== count || count === 0) {
    return Array.from({ length: count }, () => 100 / Math.max(count, 1));
  }
  const total = sizes.reduce((sum, v) => sum + v, 0);
  if (total <= 0) {
    return Array.from({ length: count }, () => 100 / Math.max(count, 1));
  }
  return sizes.map((v) => (v / total) * 100);
}

/** 在同一工作区内生成唯一 pane id */
export function createUniquePaneId(
  workspaceId: string,
  panes: { id: string }[],
): string {
  const used = new Set(panes.map((pane) => pane.id));
  let index = 0;
  let id = `${workspaceId}-pane-${index}`;
  while (used.has(id)) {
    index += 1;
    id = `${workspaceId}-pane-${index}`;
  }
  return id;
}
