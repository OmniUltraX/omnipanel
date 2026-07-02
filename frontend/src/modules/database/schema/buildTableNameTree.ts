import { textSearchMatches } from "../../../lib/textSearchMatch";

export type TableNameTreeNode =  | {
      kind: "folder";
      segment: string;
      key: string;
      children: TableNameTreeNode[];
    }
  | {
      kind: "table";
      tableName: string;
      key: string;
    };

interface InternalTreeNode {
  segment: string;
  pathKey: string;
  folders: Map<string, InternalTreeNode>;
  tables: { tableName: string }[];
}

function createInternalNode(segment: string, pathKey: string): InternalTreeNode {
  return { segment, pathKey, folders: new Map(), tables: [] };
}

function insertTable(root: InternalTreeNode, tableName: string) {
  const parts = tableName.split("_");
  if (parts.length === 1) {
    root.tables.push({ tableName });
    return;
  }

  let node = root;
  let pathKey = "";
  for (let i = 0; i < parts.length - 1; i += 1) {
    const segment = parts[i];
    pathKey = pathKey ? `${pathKey}_${segment}` : segment;
    let child = node.folders.get(segment);
    if (!child) {
      child = createInternalNode(segment, `folder:${pathKey}`);
      node.folders.set(segment, child);
    }
    node = child;
  }

  node.tables.push({ tableName });
}

function flattenSingleChainTable(node: InternalTreeNode): TableNameTreeNode | null {
  if (node.tables.length > 0 || node.folders.size !== 1) {
    return null;
  }

  let current = node.folders.values().next().value as InternalTreeNode;
  while (current.folders.size === 1 && current.tables.length === 0) {
    current = current.folders.values().next().value as InternalTreeNode;
  }

  if (current.folders.size === 0 && current.tables.length === 1) {
    const { tableName } = current.tables[0];
    return { kind: "table", tableName, key: tableName };
  }

  return null;
}

function internalToTreeNodes(node: InternalTreeNode): TableNameTreeNode[] {
  const flattened = flattenSingleChainTable(node);
  if (flattened) {
    return [flattened];
  }

  const items: TableNameTreeNode[] = [];

  for (const [segment, folder] of [...node.folders.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const children = internalToTreeNodes(folder);
    if (children.length === 1 && children[0].kind === "table") {
      items.push(children[0]);
      continue;
    }
    items.push({
      kind: "folder",
      segment,
      key: folder.pathKey,
      children,
    });
  }

  for (const table of [...node.tables].sort((a, b) => a.tableName.localeCompare(b.tableName))) {
    items.push({
      kind: "table",
      tableName: table.tableName,
      key: table.tableName,
    });
  }

  return items;
}

export function buildTableNameTree(tableNames: string[]): TableNameTreeNode[] {
  const root = createInternalNode("", "root");
  for (const tableName of tableNames) {
    insertTable(root, tableName);
  }
  return internalToTreeNodes(root);
}

export function countTableTreeLeaves(node: TableNameTreeNode): number {
  if (node.kind === "table") {
    return 1;
  }
  return node.children.reduce((sum, child) => sum + countTableTreeLeaves(child), 0);
}

export function filterTableNameTree(
  nodes: TableNameTreeNode[],
  query: string,
  tableComments?: ReadonlyMap<string, string>,
): TableNameTreeNode[] {
  const q = query.trim();
  if (!q) {
    return nodes;
  }

  const result: TableNameTreeNode[] = [];
  for (const node of nodes) {
    if (node.kind === "table") {
      const comment = tableComments?.get(node.tableName);
      if (
        textSearchMatches(q, node.tableName) ||
        (comment && textSearchMatches(q, comment))
      ) {
        result.push(node);
      }
      continue;
    }

    const folderMatches = textSearchMatches(q, node.segment);
    const filteredChildren = filterTableNameTree(node.children, query, tableComments);
    if (folderMatches) {
      result.push(node);
    } else if (filteredChildren.length > 0) {
      result.push({ ...node, children: filteredChildren });
    }
  }
  return result;
}

export function collectTableTreeFolderKeys(nodes: TableNameTreeNode[]): string[] {
  const keys: string[] = [];
  for (const node of nodes) {
    if (node.kind === "folder") {
      keys.push(node.key);
      keys.push(...collectTableTreeFolderKeys(node.children));
    }
  }
  return keys;
}
