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
  /** 旧版 dockview 侧/底 Tab 栏字段，加载时由 stripSideHeaderLayout 剥除 */
  headerPosition?: string;
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
  // 即使 panel 数量和 tabIds 一致，grid 中 leaf.views 引用的 id 仍可能不在
  // panels 字典中（v3/v4 早期脏数据）。这种"views 漂移"会让 dockview 在
  // _deserializer.fromJSON(panels[child]) 拿到 undefined 并抛出。检测到则要求
  // 走 stripMissingPanels 重新对齐。
  const viewsIds = collectViewIds(base);
  for (const id of viewsIds) {
    if (!allowed.has(id)) return true;
  }
  return false;
}

/** 收集 grid 中所有 leaf.views 引用的 panel id（不依赖 panels 字典）。 */
function collectViewIds(layout: SerializedDockview): Set<string> {
  const ids = new Set<string>();
  const walk = (node: SerializedNode | null | undefined) => {
    if (!node) return;
    if (isLeaf(node)) {
      for (const id of node.data.views ?? []) ids.add(id);
      return;
    }
    if (isBranch(node)) {
      for (const child of node.data) walk(child);
    }
  };
  walk(layout.grid?.root as SerializedNode | undefined);
  return ids;
}

/** 校验已合并布局是否结构完好（panels↔views 一致 + 每个 leaf 有合法 id）。 */
export function isLayoutUsable(
  layout: SerializedDockview | null,
): layout is SerializedDockview {
  if (!layout) return false;
  const panelIds = new Set(Object.keys(layout.panels ?? {}));
  if (panelIds.size === 0) return false;
  const root = layout.grid?.root as SerializedNode | undefined;
  if (!root) return false;
  let foundUsableLeaf = false;
  const walk = (node: SerializedNode | null | undefined): boolean => {
    if (!node) return true;
    if (isLeaf(node)) {
      if (typeof node.data?.id !== "string" || node.data.id.length === 0) return false;
      const views = node.data.views ?? [];
      if (views.length === 0) return false;
      for (const id of views) {
        if (!panelIds.has(id)) return false;
      }
      foundUsableLeaf = true;
      return true;
    }
    if (isBranch(node)) {
      if (!Array.isArray(node.data) || node.data.length === 0) return false;
      for (const child of node.data) {
        if (!walk(child)) return false;
      }
      return true;
    }
    return false;
  };
  if (!walk(root)) return false;
  return foundUsableLeaf;
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
  // stripMissingPanels 的"全空"兜底会产生一个无 id 的空 leaf —— 这种情况
  // 当且仅当 panels 字典里有内容但 grid 中没有匹配 leaf 时出现，视为
  // "views 漂移"，必须走 addMissingPanels 重建 grid。
  if (!isLayoutUsable(cleaned)) {
    return stripSideHeaderLayout(addMissingPanels(cleaned, tabIds));
  }
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

/** group 在窗口中的边缘接触关系 */
export interface DockGroupRegion {
  top: boolean;
  right: boolean;
  bottom: boolean;
  left: boolean;
}

/** group（leaf）在分屏树中的摘要 */
export interface DockGroupSnapshot {
  id: string;
  views: string[];
  activeView?: string;
  /** sash 相对尺寸 */
  size?: number;
  /** 从 grid 根到该 leaf 的路径，如 `branch[0] > branch[1] > leaf` */
  path: string;
  /** 是否接触窗口对应边缘（用于窗口拖拽区 / 控制按钮定位） */
  region: DockGroupRegion;
}

/** 单个 panel 在布局中的位置摘要 */
export interface DockPanelPlacement {
  id: string;
  groupId: string;
  /** 在 group tab 栏中的顺序（0-based） */
  tabIndex: number;
  isActiveInGroup: boolean;
  groupPath: string;
  groupSize?: number;
}

/** 方案 A：`onSavedLayoutChange` 收到 layout 后，用此结构解析可读位置信息 */
export interface DockLayoutSnapshot {
  activeGroup: string | null;
  orientation: string | null;
  groups: DockGroupSnapshot[];
  panels: DockPanelPlacement[];
}

function splitOrientationAtDepth(
  rootOrientation: string,
  depth: number,
): "HORIZONTAL" | "VERTICAL" {
  const root = rootOrientation === "VERTICAL" ? "VERTICAL" : "HORIZONTAL";
  if (depth % 2 === 0) return root;
  return root === "HORIZONTAL" ? "VERTICAL" : "HORIZONTAL";
}

function applySplitConstraint(
  region: DockGroupRegion,
  orientation: "HORIZONTAL" | "VERTICAL",
  index: number,
  siblingCount: number,
): DockGroupRegion {
  const next = { ...region };
  if (orientation === "VERTICAL") {
    if (index > 0) next.top = false;
    if (index < siblingCount - 1) next.bottom = false;
  } else {
    if (index > 0) next.left = false;
    if (index < siblingCount - 1) next.right = false;
  }
  return next;
}

function walkGridLeaves(
  node: SerializedNode,
  path: string,
  groups: DockGroupSnapshot[],
  rootOrientation: string,
  depth: number,
  region: DockGroupRegion,
): void {
  if (isLeaf(node)) {
    const groupId = node.data.id ?? path;
    groups.push({
      id: groupId,
      views: node.data.views ?? [],
      activeView: node.data.activeView,
      size: node.size,
      path: path || "leaf",
      region: { ...region },
    });
    return;
  }
  const orientation = splitOrientationAtDepth(rootOrientation, depth);
  node.data.forEach((child, index) => {
    const childPath = path ? `${path} > branch[${index}]` : `branch[${index}]`;
    const childRegion = applySplitConstraint(
      region,
      orientation,
      index,
      node.data.length,
    );
    walkGridLeaves(child, childPath, groups, rootOrientation, depth + 1, childRegion);
  });
}

/**
 * 将 `SerializedDockview`（来自 `onSavedLayoutChange` / `api.toJSON()`）
 * 解析为 panel 位置与 group 分屏摘要。
 */
export function describeDockLayout(
  layout: SerializedDockview | null,
): DockLayoutSnapshot | null {
  if (!layout) return null;

  const groups: DockGroupSnapshot[] = [];
  const rootOrientation = layout.grid?.orientation ?? "HORIZONTAL";
  const root = layout.grid?.root;
  const fullRegion: DockGroupRegion = {
    top: true,
    right: true,
    bottom: true,
    left: true,
  };
  if (root) {
    walkGridLeaves(fromGridNode(root), "", groups, rootOrientation, 0, fullRegion);
  }

  const panels: DockPanelPlacement[] = [];
  for (const group of groups) {
    group.views.forEach((panelId, tabIndex) => {
      panels.push({
        id: panelId,
        groupId: group.id,
        tabIndex,
        isActiveInGroup: group.activeView === panelId,
        groupPath: group.path,
        groupSize: group.size,
      });
    });
  }

  return {
    activeGroup: layout.activeGroup ?? null,
    orientation: layout.grid?.orientation ?? null,
    groups,
    panels,
  };
}
