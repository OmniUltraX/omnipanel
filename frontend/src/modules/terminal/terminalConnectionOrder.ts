const STORAGE_KEY = "omnipanel-terminal-connection-order";

export function readConnectionOrder(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

export function writeConnectionOrder(order: string[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(order));
}

/** 合并已保存顺序与当前连接 id，保留用户排序并追加新连接 */
export function mergeConnectionOrder(savedOrder: string[], resourceIds: string[]): string[] {
  const active = new Set(resourceIds);
  const merged = savedOrder.filter((id) => active.has(id));
  for (const id of resourceIds) {
    if (!merged.includes(id)) merged.push(id);
  }
  return merged;
}

export function moveConnectionInOrder(
  order: string[],
  sourceId: string,
  targetId: string,
  position: "before" | "after",
): string[] {
  if (sourceId === targetId) return order;
  const next = order.filter((id) => id !== sourceId);
  const targetIdx = next.indexOf(targetId);
  if (targetIdx < 0) {
    next.push(sourceId);
    return next;
  }
  const insertIdx = position === "before" ? targetIdx : targetIdx + 1;
  next.splice(insertIdx, 0, sourceId);
  return next;
}

export type ConnectionGroupLike = {
  resourceId: string;
  name: string;
  sessions: unknown[];
};

export function sortConnectionGroups<T extends ConnectionGroupLike>(
  groups: T[],
  order: string[],
): T[] {
  const map = new Map(groups.map((group) => [group.resourceId, group]));
  const sorted: T[] = [];
  for (const resourceId of order) {
    const group = map.get(resourceId);
    if (group) {
      sorted.push(group);
      map.delete(resourceId);
    }
  }
  for (const group of map.values()) {
    sorted.push(group);
  }
  return sorted;
}
