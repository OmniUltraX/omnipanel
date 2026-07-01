import { listen } from "@tauri-apps/api/event";
import { isConnectionEnabled, listConnections } from "./api";
import type { SchemaCacheConnectionEntry, SchemaCacheSnapshot } from "./schemaCache";
import type { SchemaCacheRefreshReporter } from "./schemaCacheRefresh";
import { useDbSchemaCacheStore } from "../../stores/dbSchemaCacheStore";
import type { BackgroundTaskInfo } from "../../stores/backgroundTaskStore";
import { submitDbSchemaCacheRefresh } from "../../stores/backgroundTaskStore";

export const SCHEMA_CACHE_CONNECTION_PATCHED_EVENT = "omnipanel:schema-cache-connection-patched";
export const SCHEMA_CACHE_REFRESH_COMPLETE_EVENT = "omnipanel:schema-cache-refresh-complete";

export interface BgTaskSchemaCacheEvent {
  taskId: string;
  eventType: string;
  connectionId?: string | null;
  connectionName?: string | null;
  entry?: SchemaCacheConnectionEntry | null;
  snapshot?: SchemaCacheSnapshot | null;
  error?: string | null;
}

const refreshingConnectionIds = new Set<string>();
const connectionIdsByTaskId = new Map<string, string[]>();
const reporterByTaskId = new Map<string, SchemaCacheRefreshReporter>();
const refreshStateListeners = new Set<() => void>();
let schemaCacheBgTaskInitialized = false;

function notifyRefreshStateChange() {
  for (const listener of refreshStateListeners) {
    listener();
  }
}

export function subscribeSchemaCacheRefreshState(listener: () => void): () => void {
  refreshStateListeners.add(listener);
  return () => {
    refreshStateListeners.delete(listener);
  };
}

export function isSchemaCacheConnectionRefreshing(connId: string): boolean {
  return refreshingConnectionIds.has(connId);
}

function markConnectionsRefreshing(connIds: string[], taskId: string) {
  const store = useDbSchemaCacheStore.getState();
  for (const connId of connIds) {
    refreshingConnectionIds.add(connId);
    store.setConnectionRefreshing(connId, true);
  }
  connectionIdsByTaskId.set(taskId, connIds);
  notifyRefreshStateChange();
}

function unmarkTaskRefreshing(taskId: string) {
  const connIds = connectionIdsByTaskId.get(taskId) ?? [];
  const store = useDbSchemaCacheStore.getState();
  for (const connId of connIds) {
    refreshingConnectionIds.delete(connId);
    store.setConnectionRefreshing(connId, false);
  }
  connectionIdsByTaskId.delete(taskId);
  reporterByTaskId.delete(taskId);
  notifyRefreshStateChange();
}

function dispatchConnectionPatched(connId: string, entry: SchemaCacheConnectionEntry) {
  window.dispatchEvent(
    new CustomEvent(SCHEMA_CACHE_CONNECTION_PATCHED_EVENT, {
      detail: { connId, entry },
    }),
  );
}

function dispatchRefreshComplete(snapshot: SchemaCacheSnapshot) {
  window.dispatchEvent(
    new CustomEvent(SCHEMA_CACHE_REFRESH_COMPLETE_EVENT, {
      detail: { snapshot },
    }),
  );
}

async function resolveTargetConnectionIds(connectionIds?: string[]): Promise<string[]> {
  if (connectionIds && connectionIds.length > 0) {
    return connectionIds;
  }
  const list = await listConnections();
  return list.filter(isConnectionEnabled).map((conn) => conn.id);
}

/** 订阅 Schema 缓存后台任务事件，在 initBackgroundTasks 中调用一次。 */
export function initSchemaCacheBackgroundTasks() {
  if (schemaCacheBgTaskInitialized) return;
  schemaCacheBgTaskInitialized = true;

  const unsubs: Array<() => void> = [];

  listen<BgTaskSchemaCacheEvent>("bg-task-schema-cache-event", (event) => {
    const payload = event.payload;
    const reporter = reporterByTaskId.get(payload.taskId);

    if (payload.eventType === "connection_done") {
      const connId = payload.connectionId;
      const entry = payload.entry;
      if (connId && entry) {
        void useDbSchemaCacheStore.getState().patchConnection(connId, entry);
        dispatchConnectionPatched(connId, entry);
      }
      if (payload.connectionName && reporter) {
        const connIds = connectionIdsByTaskId.get(payload.taskId) ?? [];
        const index = Math.max(1, connIds.indexOf(connId ?? "") + 1);
        const total = connIds.length || 1;
        reporter.onConnectionStart?.({
          name: payload.connectionName,
          index,
          total,
        });
        reporter.onConnectionComplete?.({
          name: payload.connectionName,
          index,
          total,
          databaseCount: entry?.databases.length ?? 0,
        });
      }
      return;
    }

    if (payload.eventType === "complete") {
      if (payload.snapshot) {
        void useDbSchemaCacheStore.getState().replaceSnapshot(payload.snapshot);
        dispatchRefreshComplete(payload.snapshot);
      }
      reporter?.onComplete?.();
      unmarkTaskRefreshing(payload.taskId);
      return;
    }

    if (payload.eventType === "failed") {
      reporter?.onError?.(payload.error ?? "Schema 缓存刷新失败");
      unmarkTaskRefreshing(payload.taskId);
    }
  })
    .then((fn) => unsubs.push(fn))
    .catch(() => {});

  listen<BackgroundTaskInfo>("bg-task-update", (event) => {
    const task = event.payload;
    if (task.kind !== "dbSchemaCacheRefresh") return;
    if (
      task.status === "failed" ||
      task.status === "cancelled"
    ) {
      const reporter = reporterByTaskId.get(task.id);
      if (task.status === "failed") {
        reporter?.onError?.(task.error ?? "Schema 缓存刷新失败");
      }
      unmarkTaskRefreshing(task.id);
    }
  })
    .then((fn) => unsubs.push(fn))
    .catch(() => {});

  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      for (const fn of unsubs) fn();
    });
  }
}

/** 提交 Schema 缓存刷新后台任务，立即返回 taskId。 */
export async function submitSchemaCacheRefresh(
  connectionIds?: string[],
  reporter?: SchemaCacheRefreshReporter,
): Promise<string> {
  const targetIds = await resolveTargetConnectionIds(connectionIds);
  if (targetIds.length === 0) {
    return "";
  }

  reporter?.onStart?.({ connectionCount: targetIds.length });

  const taskId = await submitDbSchemaCacheRefresh(
    connectionIds && connectionIds.length > 0 ? connectionIds : null,
  );
  markConnectionsRefreshing(targetIds, taskId);
  if (reporter) {
    reporterByTaskId.set(taskId, reporter);
  }
  return taskId;
}
