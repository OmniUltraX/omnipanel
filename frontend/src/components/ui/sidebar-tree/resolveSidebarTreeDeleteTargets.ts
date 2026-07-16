/**
 * 右键 / 快捷键删除时解析目标：
 * - 若点击项已在多选集合中，返回集合内（可过滤）全部 id；
 * - 否则只返回点击项。
 */
export function resolveSidebarTreeDeleteTargets(
  clickedId: string,
  selectedIds: ReadonlySet<string> | Iterable<string> | null | undefined,
  options?: {
    /** 仅保留可删除的同类节点（如只删连接、不删子节点） */
    filter?: (id: string) => boolean;
  },
): string[] {
  const selected =
    selectedIds instanceof Set
      ? selectedIds
      : selectedIds
        ? new Set(selectedIds)
        : null;
  const filter = options?.filter;

  if (selected && selected.size > 1 && selected.has(clickedId)) {
    const ids = Array.from(selected).filter((id) => (filter ? filter(id) : true));
    if (ids.length > 0) {
      return ids;
    }
  }

  if (filter && !filter(clickedId)) {
    return [];
  }
  return [clickedId];
}
