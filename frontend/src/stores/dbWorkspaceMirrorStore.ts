import type { DbWorkspaceContextValue } from "../contexts/DbWorkspaceContext";
import type { DbWorkspaceTab } from "../modules/database/workspaceTabs";

export interface MirroredDbTabSnapshot {
  ctx: DbWorkspaceContextValue;
  tab: DbWorkspaceTab;
}

let mirrorContext: DbWorkspaceContextValue | null = null;
const tabSnapshots = new Map<string, MirroredDbTabSnapshot>();
const tabVersions = new Map<string, number>();
const tabListeners = new Map<string, Set<() => void>>();

/** 供底部镜像读取的最新 context（引用随 DatabasePanel 更新）。 */
export function getDbWorkspaceMirrorContext(): DbWorkspaceContextValue | null {
  return mirrorContext;
}

export function getMirroredDbTabSnapshot(tabId: string): MirroredDbTabSnapshot | null {
  return tabSnapshots.get(tabId) ?? null;
}

/** useSyncExternalStore 的 getSnapshot：返回原始类型版本号，避免对象引用不稳定。 */
export function getMirroredDbTabVersion(tabId: string): number {
  return tabVersions.get(tabId) ?? 0;
}

export function subscribeMirroredDbTab(tabId: string, listener: () => void): () => void {
  let set = tabListeners.get(tabId);
  if (!set) {
    set = new Set();
    tabListeners.set(tabId, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) {
      tabListeners.delete(tabId);
    }
  };
}

function bumpMirroredDbTabVersion(tabId: string): void {
  tabVersions.set(tabId, (tabVersions.get(tabId) ?? 0) + 1);
  tabListeners.get(tabId)?.forEach((listener) => listener());
}

/** 生成 Tab 镜像渲染所需的 revision（忽略 cursorOffset、activeTabId 等易引发循环的字段）。 */
function buildMirroredTabRevision(ctx: DbWorkspaceContextValue, tabId: string): string {
  const tab = ctx.tabs.find((item) => item.id === tabId);
  const tabState = ctx.sqlTabStates[tabId];
  const preview = ctx.tablePreviews[tabId];

  const tabStateForMirror = tabState
    ? {
        sql: tabState.sql,
        database: tabState.database,
        running: tabState.running,
        error: tabState.error,
        elapsed: tabState.elapsed,
        result: tabState.result,
      }
    : null;

  return JSON.stringify({
    tab,
    tabState: tabStateForMirror,
    preview,
    colMeta: ctx.tableColumnMeta[tabId],
    mode: ctx.tabModes[tabId],
    dirty: ctx.tabDirtyRows[tabId],
    committing: ctx.committingTabs.has(tabId),
    activeTableKey: ctx.activeTableKey,
    activeConnId: ctx.activeConn?.id ?? null,
    databasesForActiveConn: ctx.databasesForActiveConn,
    schemaLoadingKey: ctx.schemaLoadingKey,
    sqlCompletionCount: ctx.sqlCompletionSchemas.length,
  });
}

/**
 * 更新镜像 context，并仅通知内容实际变化的已 dock Tab。
 * 返回新的 revision 缓存供下次 diff。
 */
export function publishDbWorkspaceMirror(
  context: DbWorkspaceContextValue | null,
  dockedTabIds: readonly string[],
  prevRevisions: Map<string, string>,
): Map<string, string> {
  mirrorContext = context;

  if (!context) {
    // 不在卸载时清空：底部工作区 SQL/表 Tab 仍依赖最近一次镜像快照
    return prevRevisions;
  }

  const nextRevisions = new Map<string, string>();
  const dockedSet = new Set(dockedTabIds);

  for (const tabId of dockedTabIds) {
    const revision = buildMirroredTabRevision(context, tabId);
    nextRevisions.set(tabId, revision);
    if (prevRevisions.get(tabId) === revision) {
      continue;
    }
    const tab = context.tabs.find((item) => item.id === tabId);
    if (!tab) {
      tabSnapshots.delete(tabId);
      bumpMirroredDbTabVersion(tabId);
      continue;
    }
    tabSnapshots.set(tabId, { ctx: context, tab });
    bumpMirroredDbTabVersion(tabId);
  }

  for (const tabId of prevRevisions.keys()) {
    if (dockedSet.has(tabId)) continue;
    nextRevisions.delete(tabId);
    tabSnapshots.delete(tabId);
    bumpMirroredDbTabVersion(tabId);
  }

  return nextRevisions;
}
