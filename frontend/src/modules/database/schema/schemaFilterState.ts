/** Schema 侧栏库/表过滤状态（纯逻辑，无 UI 依赖）。 */

export interface SchemaFilterState {
  orderedNames: string[];
  visibleNames: Set<string>;
  /** 固定到同级列表顶部的表名（按固定顺序） */
  pinnedNames?: string[];
}

export function createDefaultFilter(names: string[]): SchemaFilterState {
  return {
    orderedNames: [...names],
    visibleNames: new Set(names),
    pinnedNames: [],
  };
}

function insertAtNaturalPosition(orderedNames: string[], tableName: string): string[] {
  const next = orderedNames.filter((name) => name !== tableName);
  const insertIndex = next.findIndex(
    (name) => name.localeCompare(tableName, undefined, { sensitivity: "base" }) > 0,
  );
  if (insertIndex < 0) {
    next.push(tableName);
  } else {
    next.splice(insertIndex, 0, tableName);
  }
  return next;
}

/** 将固定表置于 orderedNames 最前，其余保持相对顺序。 */
export function applyTablePinOrder(
  orderedNames: string[],
  pinnedNames: string[],
  allNames: string[],
): string[] {
  const nameSet = new Set(allNames);
  const pinned = pinnedNames.filter((name) => nameSet.has(name));
  if (pinned.length === 0) {
    return orderedNames.filter((name) => nameSet.has(name));
  }
  const pinnedSet = new Set(pinned);
  const unpinned = orderedNames.filter((name) => nameSet.has(name) && !pinnedSet.has(name));
  return [...pinned, ...unpinned];
}

export function isTablePinned(filter: SchemaFilterState | undefined, tableName: string): boolean {
  return filter?.pinnedNames?.includes(tableName) ?? false;
}

export function toggleTablePin(
  filter: SchemaFilterState | undefined,
  tableName: string,
  allNames: string[],
): SchemaFilterState {
  const base = filter ?? createDefaultFilter(allNames);
  const pinned = [...(base.pinnedNames ?? [])];
  const isPinned = pinned.includes(tableName);

  if (isPinned) {
    const nextPinned = pinned.filter((name) => name !== tableName);
    const unpinnedBase = base.orderedNames.filter(
      (name) => allNames.includes(name) && !nextPinned.includes(name) && name !== tableName,
    );
    const unpinnedOrdered = insertAtNaturalPosition(unpinnedBase, tableName);
    return {
      ...base,
      pinnedNames: nextPinned,
      orderedNames: [...nextPinned, ...unpinnedOrdered],
    };
  }

  const nextPinned = [tableName, ...pinned.filter((name) => name !== tableName)];
  const unpinned = base.orderedNames.filter(
    (name) => allNames.includes(name) && !nextPinned.includes(name),
  );
  return {
    ...base,
    pinnedNames: nextPinned,
    orderedNames: [...nextPinned, ...unpinned],
  };
}

export function mergeFilter(
  existing: SchemaFilterState | undefined,
  names: string[],
  options?: { showAll?: boolean },
): SchemaFilterState {
  if (!existing) {
    return createDefaultFilter(names);
  }

  const nameSet = new Set(names);
  const previousNameSet = new Set(existing.orderedNames);
  const pinnedNames = (existing.pinnedNames ?? []).filter((name) => nameSet.has(name));
  const pinnedSet = new Set(pinnedNames);
  const kept = existing.orderedNames.filter((name) => nameSet.has(name));
  const newlyDiscovered = names.filter((name) => !existing.orderedNames.includes(name));
  // 手动刷新（showAll）或有新库/表时：未置顶项按字母重排；其余静默同步保留用户拖拽顺序
  const shouldResort = Boolean(options?.showAll) || newlyDiscovered.length > 0;
  const orderedNames = shouldResort
    ? [
        ...pinnedNames,
        ...[
          ...kept.filter((name) => !pinnedSet.has(name)),
          ...newlyDiscovered.filter((name) => !pinnedSet.has(name)),
        ].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })),
      ]
    : applyTablePinOrder(kept, pinnedNames, names);
  // 保留用户已勾选可见项；刷新后新发现的库/表默认可见（否则侧栏刷新后新建表不显示）
  const visibleNames = new Set([...existing.visibleNames].filter((name) => nameSet.has(name)));
  for (const name of names) {
    if (!previousNameSet.has(name)) {
      visibleNames.add(name);
    }
  }
  // 手动刷新：展示当前库全部对象（用户点刷新就是要看到最新全集）
  if (options?.showAll) {
    names.forEach((name) => visibleNames.add(name));
  }
  if (visibleNames.size === 0) {
    names.forEach((name) => visibleNames.add(name));
  }

  return { orderedNames, visibleNames, pinnedNames };
}

export function getVisibleItems<T extends { name: string }>(
  items: T[],
  filter: SchemaFilterState | undefined,
): T[] {
  if (!filter) {
    return items;
  }

  const orderMap = new Map(filter.orderedNames.map((name, index) => [name, index]));
  return items
    .filter((item) => filter.visibleNames.has(item.name))
    .sort((a, b) => (orderMap.get(a.name) ?? 9999) - (orderMap.get(b.name) ?? 9999));
}

/** 按侧栏过滤规则返回可见的数据库名列表（保持排序）。 */
export function getVisibleNames(names: string[], filter: SchemaFilterState | undefined): string[] {
  return getVisibleItems(
    names.map((name) => ({ name })),
    filter,
  ).map((item) => item.name);
}

export function makeTableFilterKey(connId: string, dbName: string): string {
  return `${connId}:${dbName}`;
}
