import type { DbConnectionGroup } from "../../stores/dbGroupStore";
import { connectionMatchesGroup } from "./api";
import { getVisibleItems, makeTableFilterKey, type SchemaFilterState } from "./DatabaseFilterDialog";
import type { CachedConnection } from "./schemaCacheMerge";
import { connectionNodeId } from "./schemaTreeExpanded";
import {
  connectionDatabasesFolderId,
  databaseTablesFolderId,
  parseDatabaseNodeId,
  parseTableNodeId,
  parseViewNodeId,
} from "./schemaTreeIds";
import { getSchemaChildVisibleLimit } from "./schemaTreePagination";

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
  if (params.activeConnId) {
    return connectionNodeId(params.activeConnId);
  }
  return null;
}

function resolveGroupForConnection(
  groups: DbConnectionGroup[],
  connections: CachedConnection[],
  connId: string,
  preferredGroupId?: string,
): DbConnectionGroup | null {
  if (preferredGroupId) {
    const preferred = groups.find((group) => group.id === preferredGroupId);
    if (
      preferred &&
      connections.some(
        (conn) =>
          conn.config.id === connId && connectionMatchesGroup(conn.config, preferred.name),
      )
    ) {
      return preferred;
    }
  }
  return (
    groups.find((group) =>
      connections.some(
        (conn) =>
          conn.config.id === connId && connectionMatchesGroup(conn.config, group.name),
      ),
    ) ?? null
  );
}

function ensureMinChildLimit(
  limits: Record<string, number>,
  parentNodeId: string,
  minVisibleCount: number,
  patch: Record<string, number>,
): void {
  if (minVisibleCount <= 0) {
    return;
  }
  const current = getSchemaChildVisibleLimit(limits, parentNodeId);
  if (current >= minVisibleCount) {
    return;
  }
  patch[parentNodeId] = minVisibleCount;
}

export function resolveScrollTargetGroupId(
  targetId: string,
  params: {
    groups: DbConnectionGroup[];
    connections: CachedConnection[];
    activeGroupId?: string;
    activeConnId?: string | null;
  },
): string | undefined {
  const tableParsed = parseTableNodeId(targetId) ?? parseViewNodeId(targetId);
  const databaseParsed = parseDatabaseNodeId(targetId);
  const connId =
    tableParsed?.connId ??
    databaseParsed?.connId ??
    params.activeConnId ??
    (targetId.startsWith("conn:") ? targetId.slice(5) : null);
  if (!connId) {
    return params.activeGroupId;
  }
  return resolveGroupForConnection(
    params.groups,
    params.connections,
    connId,
    params.activeGroupId,
  )?.id;
}

export function collectExpandedIdsForScrollTarget(
  targetId: string,
  groupId?: string,
): string[] {
  const ids: string[] = [];
  if (groupId) {
    ids.push(`grp:${groupId}`);
  }

  const tableParsed = parseTableNodeId(targetId) ?? parseViewNodeId(targetId);
  if (tableParsed) {
    const { connId, dbName } = tableParsed;
    ids.push(connectionNodeId(connId));
    ids.push(connectionDatabasesFolderId(connId));
    ids.push(`db:${connId}:${dbName}`);
    ids.push(databaseTablesFolderId(connId, dbName));
    return ids;
  }

  const databaseParsed = parseDatabaseNodeId(targetId);
  if (databaseParsed) {
    ids.push(connectionNodeId(databaseParsed.connId));
    ids.push(connectionDatabasesFolderId(databaseParsed.connId));
    return ids;
  }

  if (targetId.startsWith("conn:")) {
    return ids;
  }

  return ids;
}

export function buildPaginationPatchesForScrollTarget(
  targetId: string,
  params: {
    groups: DbConnectionGroup[];
    connections: CachedConnection[];
    activeGroupId?: string;
    databaseFilters: Record<string, SchemaFilterState | undefined>;
    tableFilters: Record<string, SchemaFilterState | undefined>;
  },
  limits: Record<string, number>,
): Record<string, number> {
  const patch: Record<string, number> = {};
  const tableParsed = parseTableNodeId(targetId) ?? parseViewNodeId(targetId);
  const databaseParsed = parseDatabaseNodeId(targetId);
  const connId =
    tableParsed?.connId ??
    databaseParsed?.connId ??
    (targetId.startsWith("conn:") ? targetId.slice(5) : null);

  if (!connId) {
    return patch;
  }

  const group = resolveGroupForConnection(
    params.groups,
    params.connections,
    connId,
    params.activeGroupId,
  );
  if (group) {
    const groupNodeId = `grp:${group.id}`;
    const groupConns = params.connections.filter((conn) =>
      connectionMatchesGroup(conn.config, group.name),
    );
    const connIndex = groupConns.findIndex((conn) => conn.config.id === connId);
    ensureMinChildLimit(limits, groupNodeId, connIndex + 1, patch);
  }

  const conn = params.connections.find((item) => item.config.id === connId);
  if (!conn) {
    return patch;
  }

  const databasesFolderId = connectionDatabasesFolderId(connId);
  if (databaseParsed || tableParsed) {
    const dbName = databaseParsed?.dbName ?? tableParsed!.dbName;
    const allDatabases = conn.databases ?? [];
    const visibleDatabases = getVisibleItems(allDatabases, params.databaseFilters[connId]);
    const dbIndex = visibleDatabases.findIndex((db) => db.name === dbName);
    ensureMinChildLimit(limits, databasesFolderId, dbIndex + 1, patch);
  }

  if (tableParsed) {
    const db = conn.databases?.find((item) => item.name === tableParsed.dbName);
    const tablesFolderId = databaseTablesFolderId(connId, tableParsed.dbName);
    const allTables = db?.tables ?? [];
    const tableFilterKey = makeTableFilterKey(connId, tableParsed.dbName);
    const visibleTables = getVisibleItems(allTables, params.tableFilters[tableFilterKey]);
    const tableIndex = visibleTables.findIndex((table) => table.name === tableParsed.tableName);
    ensureMinChildLimit(limits, tablesFolderId, tableIndex + 1, patch);
  }

  return patch;
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
): boolean {
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
