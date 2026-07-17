import { startTransition } from "react";
import { listen } from "@tauri-apps/api/event";
import { isConnectionEnabled, listConnections, testConnection, type DbConnectionConfig } from "../api";
import type { SchemaCacheConnectionEntry, SchemaCacheSnapshot } from "./schemaCache";
import { mergeConnectionSchemaCacheEntry } from "./schemaCache";
import type { SchemaCacheRefreshReporter } from "./schemaCacheRefresh";
import { useDbSchemaCacheStore } from "../../../stores/dbSchemaCacheStore";
import { useDbConnectionRuntimeStore } from "../../../stores/dbConnectionRuntimeStore";
import type { BackgroundTaskInfo } from "../../../stores/backgroundTaskStore";
import { submitDbSchemaCacheRefresh } from "../../../stores/backgroundTaskStore";

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
/** 任务中尚未 connection_done 的连接（单连接即时刷新路径用） */
const connectionIdsByTaskId = new Map<string, string[]>();
/** 任务启动时的完整连接列表（进度与 complete 回写） */
const originalConnectionIdsByTaskId = new Map<string, string[]>();
const taskConnectionsDoneCount = new Map<string, number>();
const reporterByTaskId = new Map<string, SchemaCacheRefreshReporter>();
/** 全量刷新：connection_done 只缓冲，complete 时一次合并，避免边刷边改树卡死 */
const pendingEntriesByTaskId = new Map<string, Map<string, SchemaCacheConnectionEntry>>();
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

function isBulkRefreshTask(taskId: string): boolean {
  return (originalConnectionIdsByTaskId.get(taskId)?.length ?? 0) > 1;
}

function clearConnectionRefreshing(connId: string, taskId: string) {
  refreshingConnectionIds.delete(connId);
  useDbSchemaCacheStore.getState().setConnectionRefreshing(connId, false);
  const remaining = (connectionIdsByTaskId.get(taskId) ?? []).filter((id) => id !== connId);
  if (remaining.length === 0) {
    connectionIdsByTaskId.delete(taskId);
  } else {
    connectionIdsByTaskId.set(taskId, remaining);
  }
  notifyRefreshStateChange();
}

/** Schema 缓存条目是否表示连接成功（无 error；允许库列表为空）。 */
export function isSchemaCacheEntryOk(
  entry: SchemaCacheConnectionEntry | null | undefined,
): boolean {
  return Boolean(entry) && !(entry?.error && entry.error.trim());
}

/**
 * 刷新中 → connecting；本地缓存存在 ≠ 在线。
 * 绿点只由 probe 成功设置。
 */
export function syncConnectionRuntimeFromSchemaCache(connId: string): void {
  if (isSchemaCacheConnectionRefreshing(connId)) {
    useDbConnectionRuntimeStore.getState().markConnecting([connId]);
  }
}

/**
 * 打开连接 / Tab 按需：用本地缓存展示 Schema，后台测连通性（不拉库表）。
 * Schema 更新请走手动刷新。
 */
export async function probeDbConnectionRuntime(connection: DbConnectionConfig): Promise<boolean> {
  if (!isConnectionEnabled(connection)) {
    useDbConnectionRuntimeStore.getState().syncEnabled(connection.id, false);
    return false;
  }

  const runtime = useDbConnectionRuntimeStore.getState();
  runtime.markConnecting([connection.id]);

  try {
    await testConnection(connection, { quiet: true });
    runtime.markOnline([connection.id]);
    return true;
  } catch {
    runtime.markOffline([connection.id]);
    return false;
  }
}

function unmarkTaskRefreshing(taskId: string, options?: { failed?: boolean; cancelled?: boolean }) {
  const remaining = connectionIdsByTaskId.get(taskId) ?? [];
  const original = originalConnectionIdsByTaskId.get(taskId) ?? remaining;
  for (const connId of original) {
    refreshingConnectionIds.delete(connId);
  }
  useDbSchemaCacheStore.setState((state) => {
    const next = { ...state.refreshingConnectionIds };
    for (const connId of original) {
      delete next[connId];
    }
    return { refreshingConnectionIds: next };
  });
  connectionIdsByTaskId.delete(taskId);
  originalConnectionIdsByTaskId.delete(taskId);
  taskConnectionsDoneCount.delete(taskId);
  pendingEntriesByTaskId.delete(taskId);
  reporterByTaskId.delete(taskId);
  const runtime = useDbConnectionRuntimeStore.getState();
  if (options?.failed) {
    runtime.markOffline(original);
  } else if (options?.cancelled) {
    for (const connId of original) {
      if (runtime.statusByConnId[connId] === "connecting") {
        runtime.setStatus(connId, "idle");
      }
    }
  }
  // 成功：只写缓存，不改绿点；若仍停在 connecting 则回到 idle
  if (!options?.failed && !options?.cancelled) {
    for (const connId of original) {
      if (runtime.statusByConnId[connId] === "connecting") {
        runtime.setStatus(connId, "idle");
      }
    }
  }
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

function reportConnectionProgress(
  taskId: string,
  reporter: SchemaCacheRefreshReporter | undefined,
  connectionName: string | null | undefined,
  entry: SchemaCacheConnectionEntry | null | undefined,
) {
  if (!connectionName || !reporter) {
    return;
  }
  const original = originalConnectionIdsByTaskId.get(taskId) ?? [];
  const done = (taskConnectionsDoneCount.get(taskId) ?? 0) + 1;
  taskConnectionsDoneCount.set(taskId, done);
  const total = Math.max(1, original.length);
  const index = Math.min(done, total);
  reporter.onConnectionStart?.({
    name: connectionName,
    index,
    total,
  });
  reporter.onConnectionComplete?.({
    name: connectionName,
    index,
    total,
    databaseCount: entry?.databases.length ?? 0,
  });
}

function applyBufferedEntriesToStore(taskId: string): SchemaCacheSnapshot {
  const pending = pendingEntriesByTaskId.get(taskId);
  pendingEntriesByTaskId.delete(taskId);
  const store = useDbSchemaCacheStore.getState();
  const previous = store.snapshot;
  if (!pending || pending.size === 0) {
    return previous;
  }
  const connections = { ...previous.connections };
  for (const [connId, entry] of pending) {
    connections[connId] = mergeConnectionSchemaCacheEntry(connections[connId], entry);
  }
  const next: SchemaCacheSnapshot = { connections };
  // 后端 complete 时已落盘；此处只同步内存，一次合并避免 N 次改树
  void store.replaceSnapshot(next, { persist: false });
  return next;
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
      const bulk = isBulkRefreshTask(payload.taskId);

      if (connId && entry) {
        if (bulk) {
          // 全量：只缓冲 + 状态栏进度，不改侧栏树 / 不标绿点
          const previous = useDbSchemaCacheStore.getState().snapshot.connections?.[connId];
          const merged = mergeConnectionSchemaCacheEntry(previous, entry);
          let pending = pendingEntriesByTaskId.get(payload.taskId);
          if (!pending) {
            pending = new Map();
            pendingEntriesByTaskId.set(payload.taskId, pending);
          }
          pending.set(connId, merged);
        } else {
          // 单连接：仍即时 patch，打开空连接时能马上看到库名
          const previous = useDbSchemaCacheStore.getState().snapshot.connections?.[connId];
          const merged = mergeConnectionSchemaCacheEntry(previous, entry);
          startTransition(() => {
            void useDbSchemaCacheStore.getState().patchConnection(connId, merged, { persist: false });
          });
          dispatchConnectionPatched(connId, merged);
          clearConnectionRefreshing(connId, payload.taskId);
        }
      } else if (connId && !bulk) {
        clearConnectionRefreshing(connId, payload.taskId);
      }

      reportConnectionProgress(payload.taskId, reporter, payload.connectionName, entry ?? undefined);
      return;
    }

    if (payload.eventType === "complete") {
      const bulk = isBulkRefreshTask(payload.taskId);
      if (payload.snapshot) {
        void useDbSchemaCacheStore.getState().replaceSnapshot(payload.snapshot, { persist: false });
        dispatchRefreshComplete(payload.snapshot);
      } else if (bulk) {
        const snapshot = applyBufferedEntriesToStore(payload.taskId);
        startTransition(() => {
          dispatchRefreshComplete(snapshot);
        });
      } else {
        dispatchRefreshComplete(useDbSchemaCacheStore.getState().snapshot);
      }
      reporter?.onComplete?.();
      unmarkTaskRefreshing(payload.taskId);
      return;
    }

    if (payload.eventType === "failed") {
      reporter?.onError?.(payload.error ?? "Schema 缓存刷新失败");
      unmarkTaskRefreshing(payload.taskId, { failed: true });
    }
  })
    .then((fn) => unsubs.push(fn))
    .catch(() => {});

  listen<BackgroundTaskInfo>("bg-task-update", (event) => {
    const task = event.payload;
    if (task.kind !== "dbSchemaCacheRefresh") return;
    if (task.status === "failed" || task.status === "cancelled") {
      const reporter = reporterByTaskId.get(task.id);
      if (task.status === "failed") {
        reporter?.onError?.(task.error ?? "Schema 缓存刷新失败");
      }
      unmarkTaskRefreshing(task.id, {
        failed: task.status === "failed",
        cancelled: task.status === "cancelled",
      });
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

function claimConnectionsForRefresh(connIds: string[]): string[] {
  const claimed: string[] = [];
  for (const connId of connIds) {
    if (refreshingConnectionIds.has(connId)) {
      continue;
    }
    refreshingConnectionIds.add(connId);
    claimed.push(connId);
  }
  if (claimed.length === 0) {
    return claimed;
  }
  useDbSchemaCacheStore.setState((state) => {
    const next = { ...state.refreshingConnectionIds };
    for (const id of claimed) {
      next[id] = true;
    }
    return { refreshingConnectionIds: next };
  });
  notifyRefreshStateChange();
  return claimed;
}

function releaseClaimedConnections(connIds: string[]) {
  if (connIds.length === 0) {
    return;
  }
  for (const connId of connIds) {
    refreshingConnectionIds.delete(connId);
  }
  useDbSchemaCacheStore.setState((state) => {
    const next = { ...state.refreshingConnectionIds };
    for (const connId of connIds) {
      delete next[connId];
    }
    return { refreshingConnectionIds: next };
  });
  notifyRefreshStateChange();
}

function bindRefreshTaskBookkeeping(taskId: string, connIds: string[]) {
  connectionIdsByTaskId.set(taskId, [...connIds]);
  originalConnectionIdsByTaskId.set(taskId, [...connIds]);
  taskConnectionsDoneCount.set(taskId, 0);
  if (connIds.length > 1) {
    pendingEntriesByTaskId.set(taskId, new Map());
  }
}

/** 提交 Schema 缓存刷新后台任务，立即返回 taskId。同一连接并发提交会合并为一次。 */
export async function submitSchemaCacheRefresh(
  connectionIds?: string[],
  reporter?: SchemaCacheRefreshReporter,
): Promise<string> {
  // 指定连接：在任何 await 之前同步占坑，避免双击连点并行起多个「刷新 Schema」任务
  if (connectionIds && connectionIds.length > 0) {
    const claimed = claimConnectionsForRefresh(connectionIds);
    if (claimed.length === 0) {
      return "";
    }

    try {
      reporter?.onStart?.({ connectionCount: claimed.length });
      const taskId = await submitDbSchemaCacheRefresh(claimed);
      bindRefreshTaskBookkeeping(taskId, claimed);
      if (reporter) {
        reporterByTaskId.set(taskId, reporter);
      }
      return taskId;
    } catch (err) {
      releaseClaimedConnections(claimed);
      throw err;
    }
  }

  const resolvedIds = await resolveTargetConnectionIds(undefined);
  const claimed = claimConnectionsForRefresh(resolvedIds);
  if (claimed.length === 0) {
    return "";
  }

  try {
    reporter?.onStart?.({ connectionCount: claimed.length });
    // 只刷本次占坑成功的连接，避免与已在跑的单连接任务重复
    const taskId = await submitDbSchemaCacheRefresh(claimed);
    bindRefreshTaskBookkeeping(taskId, claimed);
    if (reporter) {
      reporterByTaskId.set(taskId, reporter);
    }
    return taskId;
  } catch (err) {
    releaseClaimedConnections(claimed);
    throw err;
  }
}
