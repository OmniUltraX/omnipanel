/**
 * Schema 连接树已用虚拟滚动渲染扁平行，子节点无需再截断分页。
 * 保留本模块 API，避免调用方大面积改动；始终返回全量。
 */

/** @deprecated 虚拟滚动下不再使用分页；保留常量以免外部引用报错 */
export const SCHEMA_CHILD_PAGE_SIZE = Number.MAX_SAFE_INTEGER;

export function getSchemaChildVisibleLimit(
  _limits: Record<string, number>,
  _parentNodeId: string,
): number {
  return SCHEMA_CHILD_PAGE_SIZE;
}

export function paginateSchemaChildren<T>(
  items: readonly T[],
  _parentNodeId: string,
  _limits: Record<string, number>,
  _options?: { unpaginated?: boolean },
): { visible: T[]; hasMore: boolean; total: number; remaining: number } {
  const total = items.length;
  return {
    visible: [...items],
    hasMore: false,
    total,
    remaining: 0,
  };
}

export function nextSchemaChildLimit(
  _limits: Record<string, number>,
  _parentNodeId: string,
): number {
  return SCHEMA_CHILD_PAGE_SIZE;
}
