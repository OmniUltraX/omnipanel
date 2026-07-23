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
  // 回落到连接节点 id：激活连接 Tab 时，连接树应滚动到对应连接节点。
  // 关闭最后一个表/库 Tab 后联动常只剩连接 id，此时依赖调用方的三重保护避免误滚动：
  //   1) lastLinkageScrollRef 去重：同一目标不重复滚动
  //   2) suppressLinkageScrollRef：用户刚在树上操作时抑制联动
  //   3) isSchemaFlatRowIndexInViewport：目标已在视口内时不滚动
  if (params.activeConnId) {
    return connectionNodeId(params.activeConnId);
  }
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
