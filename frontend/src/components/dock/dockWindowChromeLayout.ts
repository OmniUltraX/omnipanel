import type { SerializedDockview } from "dockview-core";
import {
  describeDockLayout,
  type DockGroupSnapshot,
  type DockLayoutSnapshot,
} from "./dockViewLayout";
import type { DockHeaderPosition } from "./dockHeaderPosition";

/** 基于布局解析的窗口 chrome 宿主（拖拽区 / 控制按钮） */
export interface DockWindowChromeLayout {
  /** describeDockLayout 完整快照 */
  snapshot: DockLayoutSnapshot;
  /** 占领窗口顶部的 group：tab 栏 drag-spacer 用于移动窗口 */
  dragGroupId: string | null;
  /** 占领窗口右上角的 group：tab 栏 drag-spacer + 窗口控制按钮 */
  controlsGroupId: string | null;
  /** drag group 内当前激活 panel */
  dragPanelId: string | null;
  /** controls group 内当前激活 panel */
  controlsPanelId: string | null;
}

function pickPrimaryGroup(
  groups: DockGroupSnapshot[],
  predicate: (group: DockGroupSnapshot) => boolean,
): DockGroupSnapshot | null {
  const matched = groups.filter(predicate);
  if (matched.length === 0) return null;
  if (matched.length === 1) return matched[0];
  // 同优先级时取 path 字典序稳定排序
  return [...matched].sort((a, b) => a.path.localeCompare(b.path))[0];
}

function resolveChromeGroups(
  groups: DockGroupSnapshot[],
  headerPosition: DockHeaderPosition,
): { dragGroupId: string | null; controlsGroupId: string | null } {
  if (groups.length === 0) {
    return { dragGroupId: null, controlsGroupId: null };
  }
  if (groups.length === 1) {
    return { dragGroupId: groups[0].id, controlsGroupId: groups[0].id };
  }

  const useTop = headerPosition === "top" || headerPosition === "left";
  const useRight = headerPosition === "top" || headerPosition === "bottom";

  const edgePrimary = useTop ? "top" : "bottom";
  const edgeSecondary = useRight ? "right" : "left";

  const edgeGroups = groups.filter((g) => g.region[edgePrimary]);
  const pool = edgeGroups.length > 0 ? edgeGroups : groups;

  const dragGroup =
    pickPrimaryGroup(pool, (g) =>
      useTop ? g.region.top && g.region.left : g.region.bottom && g.region.left,
    ) ??
    pickPrimaryGroup(pool, (g) => g.region.left) ??
    pool[0] ??
    null;

  const controlsGroup =
    pickPrimaryGroup(pool, (g) =>
      useTop
        ? g.region.top && g.region.right
        : g.region.bottom && g.region.right,
    ) ??
    pickPrimaryGroup(pool, (g) => g.region[edgeSecondary]) ??
    pool[pool.length - 1] ??
    null;

  return {
    dragGroupId: dragGroup?.id ?? null,
    controlsGroupId: controlsGroup?.id ?? null,
  };
}

/**
 * ModuleSegmentDock 专用：单 group tab 栏固定挂载 drag-spacer + 窗口控制按钮。
 */
export function resolveSegmentWindowChromeHosts(
  groupIds: string[],
): { dragGroupId: string | null; controlsGroupId: string | null } {
  const groupId = groupIds[0] ?? null;
  return { dragGroupId: groupId, controlsGroupId: groupId };
}

/**
 * 根据 `describeDockLayout` 结果确定窗口拖拽区与窗口控制按钮应挂载的 group。
 */
export function resolveDockWindowChromeLayout(
  layout: SerializedDockview | null,
  headerPosition: DockHeaderPosition = "top",
): DockWindowChromeLayout | null {
  const snapshot = describeDockLayout(layout);
  if (!snapshot) return null;

  const { dragGroupId, controlsGroupId } = resolveChromeGroups(
    snapshot.groups,
    headerPosition,
  );

  const dragGroup = snapshot.groups.find((g) => g.id === dragGroupId);
  const controlsGroup = snapshot.groups.find((g) => g.id === controlsGroupId);

  return {
    snapshot,
    dragGroupId,
    controlsGroupId,
    dragPanelId: dragGroup?.activeView ?? dragGroup?.views[0] ?? null,
    controlsPanelId: controlsGroup?.activeView ?? controlsGroup?.views[0] ?? null,
  };
}
