import { connectionNodeId } from "./schemaTreeExpanded";
import {
  databaseTablesFolderId,
  databaseViewsFolderId,
  makeDatabaseNodeId,
  parseDatabaseNodeId,
  parseTableNodeId,
  parseViewNodeId,
} from "./schemaTreeIds";
export function resolveSchemaTreeScrollTarget(params: {
  activeTableKey: string | null | undefined;
  activeDatabaseKey: string | null | undefined;
  activeConnId: string | null | undefined;
}): string | null {
  if (params.activeTableKey) {
    return params.activeTableKey;
  }
  if (params.activeDatabaseKey) {
    return params.activeDatabaseKey;
  }
  // 故意不回落到 activeConnId：
  // 关闭最后一个表/库 Tab 后联动常只剩连接 id，若滚到连接根会把树拽回顶部，
  // 破坏用户当前浏览位置（双击前单击选中也会误伤）。
  void params.activeConnId;
  return null;
}

export function collectExpandedIdsForScrollTarget(targetId: string): string[] {
  const ids: string[] = [];

  const viewParsed = parseViewNodeId(targetId);
  const tableParsed = parseTableNodeId(targetId);
  if (viewParsed || tableParsed) {
    const parsed = viewParsed ?? tableParsed!;
    const { connId, dbName } = parsed;
    ids.push(connectionNodeId(connId));
    ids.push(makeDatabaseNodeId(connId, dbName));
    ids.push(
      viewParsed
        ? databaseViewsFolderId(connId, dbName)
        : databaseTablesFolderId(connId, dbName),
    );
    return ids;
  }

  const databaseParsed = parseDatabaseNodeId(targetId);
  if (databaseParsed) {
    ids.push(connectionNodeId(databaseParsed.connId));
    return ids;
  }

  if (targetId.startsWith("conn:")) {
    return ids;
  }

  return ids;
}

export function isSchemaTreeNodeInView(
  container: HTMLElement,
  targetId: string,
): boolean {
  const node = container.querySelector<HTMLElement>(
    `[data-schema-node-id="${CSS.escape(targetId)}"]`,
  );
  if (!node) {
    return false;
  }
  const containerRect = container.getBoundingClientRect();
  const nodeRect = node.getBoundingClientRect();
  return (
    nodeRect.bottom > containerRect.top &&
    nodeRect.top < containerRect.bottom &&
    nodeRect.right > containerRect.left &&
    nodeRect.left < containerRect.right
  );
}

export function scrollSchemaTreeToNode(
  container: HTMLElement,
  targetId: string,
  scrollToIndex?: (index: number) => void,
  rowIndex?: number,
): boolean {
  if (scrollToIndex != null && rowIndex != null && rowIndex >= 0) {
    scrollToIndex(rowIndex);
    return true;
  }
  if (isSchemaTreeNodeInView(container, targetId)) {
    return true;
  }
  const node = container.querySelector<HTMLElement>(
    `[data-schema-node-id="${CSS.escape(targetId)}"]`,
  );
  if (!node) {
    return false;
  }
  node.scrollIntoView({ block: "nearest", behavior: "auto" });
  return true;
}
