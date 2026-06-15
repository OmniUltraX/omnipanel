import { makeTableFilterKey } from "./DatabaseFilterDialog";
import type { SchemaTreeItem } from "./schemaTreeItem";

export type SchemaReorderKind = "database" | "table";

export interface SchemaReorderScope {
  kind: SchemaReorderKind;
  scopeKey: string;
  name: string;
}

export interface SchemaReorderTarget {
  kind: SchemaReorderKind;
  scopeKey: string;
  insertBeforeName: string | null;
  /** 用于 drop 日志：参考 sibling 的类型 */
  referenceType: string;
}

const REORDER_SCOPE_HIGHLIGHT_CLASS = "tree-node--reorder-target-scope";

/** 仅数据库、表节点可在树内同级排序（顺序持久化在 schema filter）。 */
export function getSchemaReorderScope(item: SchemaTreeItem): SchemaReorderScope | null {
  if (item.type === "database" && item.connId && item.dbName) {
    return { kind: "database", scopeKey: item.connId, name: item.dbName };
  }
  if (item.type === "table" && item.connId && item.dbName && item.tableName) {
    return {
      kind: "table",
      scopeKey: makeTableFilterKey(item.connId, item.dbName),
      name: item.tableName,
    };
  }
  return null;
}

export function isSameReorderScope(
  source: SchemaReorderScope | null,
  target: SchemaReorderTarget | null,
): boolean {
  if (!source || !target) {
    return false;
  }
  return source.scopeKey === target.scopeKey && source.kind === target.kind;
}

export function reorderOrderedNames(
  orderedNames: string[],
  draggedName: string,
  insertBeforeName: string | null,
): string[] | null {
  const fromIndex = orderedNames.indexOf(draggedName);
  if (fromIndex < 0) {
    return null;
  }

  if (insertBeforeName === null) {
    if (fromIndex === orderedNames.length - 1) {
      return null;
    }
    const next = orderedNames.filter((name) => name !== draggedName);
    next.push(draggedName);
    return next;
  }

  const toIndex = orderedNames.indexOf(insertBeforeName);
  if (toIndex < 0) {
    return null;
  }
  if (toIndex === fromIndex) {
    return null;
  }

  const next = orderedNames.filter((name) => name !== draggedName);
  const adjustedIndex = next.indexOf(insertBeforeName);
  if (adjustedIndex < 0) {
    return null;
  }
  next.splice(adjustedIndex, 0, draggedName);

  if (next.length !== orderedNames.length) {
    return null;
  }
  for (let i = 0; i < next.length; i += 1) {
    if (next[i] !== orderedNames[i]) {
      return next;
    }
  }
  return null;
}

function queryReorderSiblingNodes(scopeKey: string, itemType: string): HTMLElement[] {
  return Array.from(
    document.querySelectorAll(
      `[data-schema-reorder-scope="${CSS.escape(scopeKey)}"][data-schema-item-type="${CSS.escape(itemType)}"]`,
    ),
  ) as HTMLElement[];
}

function collectReorderScopeKeys(itemType: string): Set<string> {
  const scopeKeys = new Set<string>();
  document
    .querySelectorAll(
      `[data-schema-reorder-scope][data-schema-item-type="${CSS.escape(itemType)}"]`,
    )
    .forEach((node) => {
      const key = node.getAttribute("data-schema-reorder-scope");
      if (key) {
        scopeKeys.add(key);
      }
    });
  return scopeKeys;
}

/** 指针所在位置的目标父级 scope（可不同于拖动源，用于跨父级 UI）。 */
function findReorderScopeKeyAtPoint(
  clientX: number,
  clientY: number,
  itemType: string,
): string | null {
  const hit = document.elementFromPoint(clientX, clientY);
  if (!hit) {
    return null;
  }

  const hitNode = hit.closest(
    `[data-schema-reorder-scope][data-schema-item-type="${CSS.escape(itemType)}"]`,
  ) as HTMLElement | null;
  if (hitNode) {
    return hitNode.getAttribute("data-schema-reorder-scope");
  }

  let bestKey: string | null = null;
  let bestDistance = Infinity;

  for (const scopeKey of collectReorderScopeKeys(itemType)) {
    const nodes = queryReorderSiblingNodes(scopeKey, itemType);
    if (nodes.length === 0) {
      continue;
    }

    const firstRect = nodes[0].getBoundingClientRect();
    const lastRect = nodes[nodes.length - 1].getBoundingClientRect();
    const top = firstRect.top - 8;
    const bottom = lastRect.bottom + 8;
    if (clientY < top || clientY > bottom) {
      continue;
    }

    if (clientX < firstRect.left - 20 || clientX > lastRect.right + 8) {
      continue;
    }

    const midY = (top + bottom) / 2;
    const distance = Math.abs(clientY - midY);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestKey = scopeKey;
    }
  }

  return bestKey;
}

/** 根据指针位置解析插入目标（含跨父级 scope）。 */
export function resolveSchemaReorderTargetAtPoint(
  clientX: number,
  clientY: number,
  dragItem: SchemaTreeItem,
): SchemaReorderTarget | null {
  if (dragItem.type !== "database" && dragItem.type !== "table") {
    return null;
  }

  const scopeKey = findReorderScopeKeyAtPoint(clientX, clientY, dragItem.type);
  if (!scopeKey) {
    return null;
  }

  const insert = resolveSchemaReorderInsert(scopeKey, dragItem.type, clientY);
  if (!insert) {
    return null;
  }

  return {
    kind: dragItem.type,
    scopeKey,
    insertBeforeName: insert.insertBeforeName,
    referenceType: insert.referenceType,
  };
}

/** 根据指针 Y 坐标计算同级插入位置（条目之间）。 */
export function resolveSchemaReorderInsert(
  scopeKey: string,
  itemType: string,
  clientY: number,
): Pick<SchemaReorderTarget, "insertBeforeName" | "referenceType"> | null {
  const nodes = queryReorderSiblingNodes(scopeKey, itemType);
  if (nodes.length === 0) {
    return null;
  }

  const firstRect = nodes[0].getBoundingClientRect();
  const lastRect = nodes[nodes.length - 1].getBoundingClientRect();
  if (clientY < firstRect.top - 4 || clientY > lastRect.bottom + 4) {
    return null;
  }

  for (const node of nodes) {
    const rect = node.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (clientY < midY) {
      return {
        insertBeforeName: node.getAttribute("data-schema-reorder-name"),
        referenceType: itemType,
      };
    }
  }

  return {
    insertBeforeName: null,
    referenceType: itemType,
  };
}

export function getSchemaReorderIndicatorRect(
  scopeKey: string,
  itemType: string,
  insertBeforeName: string | null,
): { left: number; top: number; width: number } | null {
  const nodes = queryReorderSiblingNodes(scopeKey, itemType);
  if (nodes.length === 0) {
    return null;
  }

  if (insertBeforeName === null) {
    const last = nodes[nodes.length - 1];
    const rect = last.getBoundingClientRect();
    return { left: rect.left, top: rect.bottom - 1, width: rect.width };
  }

  const node = nodes.find((el) => el.getAttribute("data-schema-reorder-name") === insertBeforeName);
  if (!node) {
    return null;
  }
  const rect = node.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width };
}

export function setSchemaReorderScopeHighlight(
  scopeKey: string,
  itemType: string,
  crossScope = false,
): void {
  clearSchemaReorderScopeHighlight();
  queryReorderSiblingNodes(scopeKey, itemType).forEach((node) => {
    node.classList.add(REORDER_SCOPE_HIGHLIGHT_CLASS);
    if (crossScope) {
      node.classList.add(`${REORDER_SCOPE_HIGHLIGHT_CLASS}--cross`);
    }
  });
}

export function clearSchemaReorderScopeHighlight(): void {
  document.querySelectorAll(`.${REORDER_SCOPE_HIGHLIGHT_CLASS}`).forEach((el) => {
    el.classList.remove(REORDER_SCOPE_HIGHLIGHT_CLASS);
    el.classList.remove(`${REORDER_SCOPE_HIGHLIGHT_CLASS}--cross`);
  });
}
