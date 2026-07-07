/** Schema 树展开后直接显示全部子节点，不再分页。 */
export function paginateSchemaChildren<T>(
  items: readonly T[],
  _parentNodeId?: string,
  _limits?: Record<string, number>,
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
