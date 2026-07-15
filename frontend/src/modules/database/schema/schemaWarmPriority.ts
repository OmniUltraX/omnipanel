import { isConnectionEnabled, listConnections } from "../api";
import { probeDbConnectionRuntime } from "./schemaCacheBackgroundTasks";
import {
  parseDatabaseNodeId,
  parseTableNodeId,
  parseViewNodeId,
} from "./schemaTreeIds";
import { useDbWorkspaceSessionStore } from "../../../stores/dbWorkspaceSessionStore";
import { useDbConnectionRuntimeStore } from "../../../stores/dbConnectionRuntimeStore";
import type { DbWorkspaceTab } from "../workspace/workspaceTabs";

/** 从展开节点 id 提取连接 id（供侧栏联动等复用） */
export function collectExpandedConnectionIds(expandedNodeIds: Iterable<string>): string[] {
  const ids = new Set<string>();
  for (const nodeId of expandedNodeIds) {
    if (nodeId.startsWith("conn:")) {
      ids.add(nodeId.slice(5));
      continue;
    }
    const table = parseTableNodeId(nodeId);
    if (table) {
      ids.add(table.connId);
      continue;
    }
    const view = parseViewNodeId(nodeId);
    if (view) {
      ids.add(view.connId);
      continue;
    }
    const db = parseDatabaseNodeId(nodeId);
    if (db) {
      ids.add(db.connId);
      continue;
    }
    // dbs:/tbls:/views: 等文件夹：`dbs:{connId}` 或 `tbls:{connId}:{db}`
    const folder = /^(?:dbs|tbls|views|other|users|cols|idxs):([^:]+)/.exec(nodeId);
    if (folder?.[1]) {
      ids.add(folder[1]);
    }
  }
  return [...ids];
}

function collectTabConnectionIds(extraTabs?: DbWorkspaceTab[]): string[] {
  const ids = new Set<string>();
  const sessionTabs = useDbWorkspaceSessionStore.getState().session?.tabs ?? [];
  for (const tab of [...sessionTabs, ...(extraTabs ?? [])]) {
    if ("connId" in tab && typeof tab.connId === "string" && tab.connId) {
      ids.add(tab.connId);
    }
  }
  return [...ids];
}

/**
 * 按需连通：仅探测「工作区 Tab 引用」的启用连接。
 * 本地 Schema 缓存可继续展示树，但不因有缓存而标绿点。
 */
export async function warmPrioritySchemaConnections(
  _reporter?: unknown,
  options?: { workspaceTabs?: DbWorkspaceTab[] },
): Promise<string[]> {
  const tabConnIds = collectTabConnectionIds(options?.workspaceTabs);
  if (tabConnIds.length === 0) {
    return [];
  }

  const list = await listConnections();
  const toProbe = list.filter(
    (conn) => tabConnIds.includes(conn.id) && isConnectionEnabled(conn),
  );
  if (toProbe.length === 0) {
    return [];
  }

  const runtime = useDbConnectionRuntimeStore.getState();
  for (const conn of list) {
    if (!isConnectionEnabled(conn)) {
      runtime.syncEnabled(conn.id, false);
    }
  }

  const onlineIds: string[] = [];
  await Promise.all(
    toProbe.map(async (conn) => {
      const ok = await probeDbConnectionRuntime(conn);
      if (ok) {
        onlineIds.push(conn.id);
      }
    }),
  );
  return onlineIds;
}
