export const SCHEMA_CHILD_PAGE_SIZE = 100;

export function getSchemaChildVisibleLimit(
  limits: Record<string, number>,
  parentNodeId: string,
): number {
  return limits[parentNodeId] ?? SCHEMA_CHILD_PAGE_SIZE;
}

export function paginateSchemaChildren<T>(
  items: readonly T[],
  parentNodeId: string,
  limits: Record<string, number>,
  options?: { unpaginated?: boolean },
): { visible: T[]; hasMore: boolean; total: number; remaining: number } {
  const total = items.length;
  if (options?.unpaginated) {
    return {
      visible: [...items],
      hasMore: false,
      total,
      remaining: 0,
    };
  }
  const limit = getSchemaChildVisibleLimit(limits, parentNodeId);
  const visible = items.slice(0, limit);
  const remaining = Math.max(0, total - visible.length);
  return {
    visible,
    hasMore: remaining > 0,
    total,
    remaining,
  };
}

export function nextSchemaChildLimit(
  limits: Record<string, number>,
  parentNodeId: string,
): number {
  return getSchemaChildVisibleLimit(limits, parentNodeId) + SCHEMA_CHILD_PAGE_SIZE;
}
