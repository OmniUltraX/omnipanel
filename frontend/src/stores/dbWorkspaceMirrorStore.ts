import type { DbWorkspaceMirrorContextValue } from "../contexts/DbWorkspaceContext.types";
import type { DbWorkspaceTab } from "../modules/database/workspace/workspaceTabs";
import { resolveSqlTabConnectionId } from "../modules/database/workspace/dbWorkspaceState";

export interface MirroredDbTabSnapshot {
  ctx: DbWorkspaceMirrorContextValue;
  tab: DbWorkspaceTab;
}

let mirrorContext: DbWorkspaceMirrorContextValue | null = null;
const tabSnapshots = new Map<string, MirroredDbTabSnapshot>();
const tabVersions = new Map<string, number>();
const tabListeners = new Map<string, Set<() => void>>();

/** 供底部镜像读取的最新 context（引用随 DatabasePanel 更新）。 */
export function getDbWorkspaceMirrorContext(): DbWorkspaceMirrorContextValue | null {
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

/** 结果对象引用 → 稳定 id，避免 revision 里 JSON.stringify 整表行数据。 */
const previewDataIdentity = new WeakMap<object, number>();
let nextPreviewDataIdentity = 1;

function previewDataIdentityId(data: object | null | undefined): number {
  if (!data) return 0;
  let id = previewDataIdentity.get(data);
  if (id == null) {
    id = nextPreviewDataIdentity++;
    previewDataIdentity.set(data, id);
  }
  return id;
}

/** 表预览 revision：元数据 + data 引用身份，不含行内容。 */
function tablePreviewMirrorFingerprint(
  preview: DbWorkspaceMirrorContextValue["tablePreviews"][string] | undefined,
): unknown {
  if (!preview) return null;
  return {
    loading: preview.loading,
    error: preview.error,
    page: preview.page,
    pageSize: preview.pageSize,
    totalRows: preview.totalRows,
    sort: preview.sort,
    filter: preview.filter,
    hiddenColumns: preview.hiddenColumns,
    transposed: preview.transposed,
    columnRelations: preview.columnRelations,
    connId: preview.connId,
    dbName: preview.dbName,
    tableName: preview.tableName,
    dataId: previewDataIdentityId(preview.data ?? undefined),
    colCount: preview.data?.columns.length ?? 0,
    rowCount: preview.data?.rows.length ?? 0,
  };
}

/** 生成 Tab 镜像渲染所需的 revision（忽略 cursorOffset、activeTabId 等易引发循环的字段）。 */
function buildMirroredTabRevision(ctx: DbWorkspaceMirrorContextValue, tabId: string): string {
  const tab = ctx.tabs.find((item) => item.id === tabId);
  const tabState = ctx.sqlTabStates[tabId];
  const preview = ctx.tablePreviews[tabId];

  const tabStateForMirror = tabState
    ? {
        connId: tabState.connId,
        sql: tabState.sql,
        database: tabState.database,
        running: tabState.running,
        error: tabState.error,
        elapsed: tabState.elapsed,
        // result 行数据同样用引用身份，避免 SQL 结果巨大时卡顿
        resultId: previewDataIdentityId(tabState.result ?? undefined),
        resultColCount: tabState.result?.columns.length ?? 0,
        resultRowCount: tabState.result?.rows.length ?? 0,
      }
    : null;

  const tabConnId = tabState
    ? resolveSqlTabConnectionId(tabId, ctx.sqlTabStates, ctx.tablePreviews)
    : "";
  const tabDatabases = tabConnId ? (ctx.databasesByConnId[tabConnId] ?? []) : [];

  return JSON.stringify({
    tab,
    tabState: tabStateForMirror,
    preview: tablePreviewMirrorFingerprint(preview),
    colMeta: ctx.tableColumnMeta[tabId],
    mode: ctx.tabModes[tabId],
    dirty: ctx.tabDirtyRows[tabId],
    committing: ctx.committingTabs.has(tabId),
    activeTableKey: ctx.activeTableKey,
    tabConnId,
    tabDatabaseCount: tabDatabases.length,
    schemaLoadingKey: ctx.schemaLoadingKey,
    sqlCompletionCount: ctx.getSqlCompletionSchemas(tabId).length,
  });
}

/**
 * 更新镜像 context，并仅通知内容实际变化的已 dock Tab。
 * 返回新的 revision 缓存供下次 diff。
 */
export function publishDbWorkspaceMirror(
  context: DbWorkspaceMirrorContextValue | null,
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
