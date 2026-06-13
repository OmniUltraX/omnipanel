import type { SerializedDockview } from "dockview-core";
import { Orientation } from "dockview-core";

/**
 * 工作区布局工具集（基于 dockview 的 SerializedDockview 序列化格式）。
 *
 * 与旧版 dockRcLayout 的语义对齐：
 * - collectPanelIds / collectTabIds：从布局中提取所有面板 ID
 * - createDefaultLayout / createDefaultRcLayout：构造一个单 group 的默认布局
 * - mergePanelsIntoLayout / mergeTabsIntoRcLayout：把外部 tab 列表与已存布局合并
 * - removePanelFromLayout / removeTabFromRcLayout：从布局移除某个 panel
 * - diffRemovedPanelIds / diffRemovedTabIds：对比前后布局，找出被删除的 ID
 *
 * 序列化结构来自 dockview-core：
 *   { grid: { root, ... }, panels: { [id]: { contentComponent, title, params } }, activeGroup?, ... }
 *
 * grid.root 是嵌套的 leaf/branch 树：
 *   - leaf.data  = GroupPanelViewState { id, views: string[], activeView? }
 *   - branch.data = SerializedNode[]
 */

type SerializedPanelState = NonNullable<SerializedDockview["panels"]>[string];
type GroupPanelViewState = {
  id?: string;
  views?: string[];
  activeView?: string;
};

interface SerializedLeaf {
  type: "leaf";
  data: GroupPanelViewState;
  size?: number;
  visible?: boolean;
}
interface SerializedBranch {
  type: "branch";
  data: SerializedNode[];
  size?: number;
}
type SerializedNode = SerializedLeaf | SerializedBranch;

function isLeaf(node: SerializedNode): node is SerializedLeaf {
  return node.type === "leaf";
}

function isBranch(node: SerializedNode): node is SerializedBranch {
  return node.type === "branch";
}

function isEmptyGroup(group: GroupPanelViewState | undefined): boolean {
  if (!group) return true;
  return !Array.isArray(group.views) || group.views.length === 0;
}

function toGridNode(node: SerializedNode): NonNullable<SerializedDockview["grid"]["root"]> {
  if (isLeaf(node)) {
    const result = {
      type: "leaf" as const,
      data: node.data as GroupPanelViewState,
      size: node.size ?? 1000,
      visible: node.visible,
    };
    return result as unknown as NonNullable<SerializedDockview["grid"]["root"]>;
  }
  return {
    type: "branch" as const,
    data: node.data.map((c) => toGridNode(c)),
    size: node.size ?? 1000,
  } as unknown as NonNullable<SerializedDockview["grid"]["root"]>;
}

function fromGridNode(node: NonNullable<SerializedDockview["grid"]["root"]>): SerializedNode {
  if (node.type === "leaf") {
    return {
      type: "leaf",
      data: (node.data ?? {}) as GroupPanelViewState,
      size: node.size ?? 1000,
      visible: node.visible,
    };
  }
  const data = Array.isArray(node.data) ? node.data : [];
  return {
    type: "branch",
    data: data.map((c) => fromGridNode(c)),
    size: node.size ?? 1000,
  };
}

/** 收集布局中所有 panel id */
export function collectPanelIds(layout: SerializedDockview): Set<string> {
  const ids = new Set<string>();
  for (const id of Object.keys(layout.panels ?? {})) {
    ids.add(id);
  }
  return ids;
}

/**
 * dockview 的 `fromJSON` 强制要求根节点 type='branch'（参见
 * `DockviewComponent.fromJSON` 的 "dockview: root must be of type branch" 校验）。
 * 单 group 场景需要用 branch 包一层 leaf。
 */
function ensureBranchRoot(
  leaf: SerializedLeaf,
  orientation: Orientation = Orientation.HORIZONTAL,
): SerializedDockview["grid"] {
  return {
    root: toGridNode({
      type: "branch",
      data: [leaf],
    }),
    height: 0,
    width: 0,
    orientation,
  };
}

/** 构造一个单 group、横向排布所有 tabs 的默认布局 */
export function createDefaultLayout(
  tabIds: string[],
  activeTabId: string,
): SerializedDockview {
  if (tabIds.length === 0) {
    return {
      grid: ensureBranchRoot({ type: "leaf", data: {} }),
      panels: {},
    };
  }

  const activeId = tabIds.includes(activeTabId) ? activeTabId : tabIds[0];
  const groupId = `group-${activeId}`;
  return {
    grid: ensureBranchRoot({
      type: "leaf",
      data: {
        id: groupId,
        views: [...tabIds],
        activeView: activeId,
      },
    }),
    panels: Object.fromEntries(
      tabIds.map((id) => [
        id,
        {
          id,
          contentComponent: "dockable-content",
          title: id,
          params: { tabId: id },
        } as SerializedPanelState,
      ]),
    ),
    activeGroup: groupId,
  };
}

function cloneLayout(layout: SerializedDockview): SerializedDockview {
  return JSON.parse(JSON.stringify(layout)) as SerializedDockview;
}

function filterGroupViews(
  group: GroupPanelViewState,
  allowed: Set<string>,
): GroupPanelViewState {
  const views = (group.views ?? []).filter((id) => allowed.has(id));
  const next: GroupPanelViewState = { ...group, views };
  if (group.activeView && !allowed.has(group.activeView)) {
    next.activeView = views[0];
  }
  return next;
}

function pruneRoot(
  node: SerializedNode,
  allowed: Set<string>,
): SerializedNode | null {
  if (isLeaf(node)) {
    const group = filterGroupViews(node.data, allowed);
    if (isEmptyGroup(group)) return null;
    return {
      type: "leaf",
      data: group,
      size: node.size,
      visible: node.visible,
    };
  }
  if (isBranch(node)) {
    const children: SerializedNode[] = [];
    for (const child of node.data) {
      const pruned = pruneRoot(child, allowed);
      if (pruned) children.push(pruned);
    }
    if (children.length === 0) return null;
    return {
      type: "branch",
      data: children,
      size: node.size,
    };
  }
  return null;
}

function stripMissingPanels(
  layout: SerializedDockview,
  allowed: Set<string>,
): SerializedDockview {
  const next = cloneLayout(layout);
  // 1) 先按 allowed 过滤 panels
  const filteredPanels = Object.fromEntries(
    Object.entries(next.panels ?? {}).filter(([id]) => allowed.has(id)),
  );
  // 2) 用"实际存活 panel id"再去修剪 views —— 必须 views 和 panels 严格一致，
  //    否则 fromJSON 走到 _deserializer.fromJSON(panels[child]) 时 panels[child] 是 undefined。
  //    旧实现按 allowed 过滤 views，会出现"view 在但 panel 不在"的不一致。
  const existingIds = new Set(Object.keys(filteredPanels));
  next.panels = filteredPanels;
  const root = fromGridNode(next.grid.root);
  const pruned = pruneRoot(root, existingIds);
  if (pruned && pruned.type === "branch") {
    next.grid.root = toGridNode(pruned);
  } else if (pruned && pruned.type === "leaf") {
    // dockview 强制要求 root 是 branch，单 leaf 需要包一层
    next.grid.root = toGridNode({ type: "branch", data: [pruned] });
  } else {
    // 全空：用空 leaf 占位
    next.grid.root = toGridNode({
      type: "branch",
      data: [{ type: "leaf", data: {} }],
    });
  }
  return next;
}

function firstLeafWithPanels(
  node: SerializedNode,
  panels: Record<string, unknown> | undefined,
): GroupPanelViewState | undefined {
  if (!panels) return undefined;
  const allowed = new Set(Object.keys(panels));
  if (isLeaf(node)) {
    const filtered = (node.data.views ?? []).filter((id) => allowed.has(id));
    if (filtered.length === 0) return undefined;
    return { ...node.data, views: filtered };
  }
  if (isBranch(node)) {
    for (const child of node.data) {
      const found = firstLeafWithPanels(child, panels);
      if (found) return found;
    }
  }
  return undefined;
}

function addMissingPanels(
  layout: SerializedDockview,
  missing: string[],
): SerializedDockview {
  const next = cloneLayout(layout);
  // 必须同时补 panels 字典和 group 的 views，否则 fromJSON 在
  // _deserializer.fromJSON(panels[child]) 仍会因 panels[child] === undefined 而炸。
  for (const id of missing) {
    next.panels[id] = {
      id,
      contentComponent: "dockable-content",
      title: id,
      params: { tabId: id },
    } as SerializedPanelState;
  }
  const panels = next.panels ?? {};
  const allowed = new Set(Object.keys(panels));
  const root = fromGridNode(next.grid.root);

  // 找到第一个还有空间（views 中有允许的 id）的 group，把缺失的 panel 加进去
  const target = firstLeafWithPanels(root, panels);
  if (target) {
    const updatedViews = [...(target.views ?? []), ...missing];
    const updatedActive = target.activeView ?? missing[0];
    const updated = mapRoot(root, (leaf) => {
      if ((leaf.data.views ?? []).some((id) => allowed.has(id))) {
        return {
          type: "leaf" as const,
          data: {
            ...leaf.data,
            views: updatedViews,
            activeView: updatedActive,
          },
          size: leaf.size,
          visible: leaf.visible,
        };
      }
      return leaf;
    });
    next.grid.root = toGridNode(updated);
  } else {
    // 没有可用 group，创建一个新的 leaf，并包一层 branch（dockview 要求）
    const activeId = missing[0];
    const groupId = `group-${activeId}`;
    const newLeaf: SerializedLeaf = {
      type: "leaf",
      data: { id: groupId, views: [...missing], activeView: activeId },
    };
    next.grid.root = toGridNode({
      type: "branch",
      data: [newLeaf],
    });
    next.activeGroup = groupId;
  }
  return next;
}

function mapRoot(
  node: SerializedNode,
  fn: (leaf: SerializedLeaf) => SerializedLeaf,
): SerializedNode {
  if (isLeaf(node)) {
    return fn(node);
  }
  if (isBranch(node)) {
    return {
      type: "branch",
      data: node.data.map((child: SerializedNode) => mapRoot(child, fn)),
      size: node.size,
    };
  }
  return node;
}

/** dockview 侧/底 Tab 栏（headerPosition + edgeGroups）——不再使用，加载时统一剥除 */
function stripSideHeaderLayout(layout: SerializedDockview): SerializedDockview {
  const next = cloneLayout(layout);
  delete (next as SerializedDockview & { edgeGroups?: unknown }).edgeGroups;

  const root = fromGridNode(next.grid.root);
  const normalized = mapRoot(root, (leaf) => {
    if (!leaf.data.headerPosition || leaf.data.headerPosition === "top") {
      return leaf;
    }
    const { headerPosition: _removed, ...data } = leaf.data;
    return { ...leaf, data };
  });
  next.grid.root = toGridNode(normalized);
  return next;
}

function layoutNeedsMerge(
  base: SerializedDockview,
  tabIds: string[],
): boolean {
  const existing = collectPanelIds(base);
  const allowed = new Set(tabIds);
  if (existing.size !== allowed.size) return true;
  for (const id of tabIds) {
    if (!existing.has(id)) return true;
  }
  return false;
}

/**
 * 将外部 tab 列表与已保存布局合并（增删 panel、修正 activeGroup）。
 * tabs 为空时返回 null。
 */
export function mergePanelsIntoLayout(
  base: SerializedDockview | null,
  tabIds: string[],
  activeTabId: string,
): SerializedDockview | null {
  if (tabIds.length === 0) return null;
  if (!base) return createDefaultLayout(tabIds, activeTabId);
  if (!layoutNeedsMerge(base, tabIds)) return stripSideHeaderLayout(base);

  const allowed = new Set(tabIds);
  const cleaned = stripMissingPanels(base, allowed);
  const missing = tabIds.filter((id) => !collectPanelIds(cleaned).has(id));
  if (missing.length === 0) return stripSideHeaderLayout(cleaned);

  return stripSideHeaderLayout(addMissingPanels(cleaned, missing));
}

/** 从布局中移除指定 panel；空布局返回 null */
export function removePanelFromLayout(
  layout: SerializedDockview | null,
  panelId: string,
): SerializedDockview | null {
  if (!layout) return null;
  const allowed = new Set(collectPanelIds(layout));
  allowed.delete(panelId);
  if (allowed.size === 0) return null;
  const fallbackActive = [...allowed][0] ?? panelId;
  return (
    mergePanelsIntoLayout(layout, [...allowed], fallbackActive) ??
    createDefaultLayout([...allowed], fallbackActive)
  );
}

/** 剥除侧/底 Tab 栏等已废弃的布局字段，避免 fromJSON 恢复旧状态 */
export function normalizeDockLayout(
  layout: SerializedDockview | null,
): SerializedDockview | null {
  if (!layout) return null;
  return stripSideHeaderLayout(layout);
}

/** 对比前后布局，找出被删除的 panel id */
export function diffRemovedPanelIds(
  prev: SerializedDockview,
  next: SerializedDockview,
): string[] {
  const prevIds = collectPanelIds(prev);
  const nextIds = collectPanelIds(next);
  return [...prevIds].filter((id) => !nextIds.has(id));
}
