import {
  startTransition,
  useCallback,
  useEffect,
  type Dispatch,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { RuleGroupType } from "react-querybuilder";
import type { TabContextMenuAction } from "../../../components/ui/menu";
import { patchDockTabPreviewMeta } from "../../../components/dock/dockTabLiveMeta";
import { appConfirm } from "../../../lib/appConfirm";
import { quickInput } from "../../../lib/quickInput";
import { dbTabToSnapshot } from "../../../lib/workspaceTabActions";
import { subscribeDockviewTransfer, relayoutDockviewInstances } from "../../../lib/dockviewRegistry";
import { deliverSnapshotToWorkspace } from "../../../lib/workspaceSnapshotDelivery";
import { registerDatabaseTabCloser } from "../databaseSessionService";
import type { DbConnectionConfig } from "../api";
import type { SyncTask } from "../toolbox/types";
import {
  findPreviewDockTab,
  findTabIdForSyncTask,
  makeSyncTaskWorkspaceTab,
  findTabIdForSqlFile,
  findTabIdForTreeChartFile,
  findTabIdForDatabase,
  findTabIdForConnection,
  findTabIdForRedisQuery,
  findTabIdForSlowQueryLog,
  findTabIdForBinlog,
  findTabIdForSqlExecLog,
  findTabIdForDesigner,
  findTabIdForTable,
  isModuleDockTab,
  isScratchSqlTab,
  type SchemaDockOpenMode,
  type DbWorkspaceTab,
} from "../workspace/workspaceTabs";
import {
  createDefaultSqlTabState,
  createDefaultTablePreviewState,
  resolveConnIdForWorkspaceTab,
  type SortState,
  type SortStates,
  type TableDesignerTabState,
} from "../workspace/dbWorkspaceState";
import {
  buildClosedPanelEntry,
  restoreTableDesignerStateFromSnapshot,
  tablePreviewStateFromSnapshot,
  type DbClosedPanelEntry,
} from "../workspace/dbWorkspaceSession";
import { restoreSqlTabStateFromSnapshot } from "../workspace/dbWorkspaceTabHelpers";
import { resolveSqlTabStateFromFile, useDbSqlFileStore } from "../../../stores/dbSqlFileStore";
import { useDbTreeChartFileStore } from "../../../stores/dbTreeChartFileStore";
import { useDbScratchQueryStore } from "../../../stores/dbScratchQueryStore";
import { useDbSyncTaskStore } from "../../../stores/dbSyncTaskStore";
import { resolveDbSidebarLinkageFromTab } from "../schema/resolveDbSidebarLinkage";
import { useDbSidebarLinkageStore } from "../../../stores/dbSidebarLinkageStore";
import { useDbDockLayoutStore, removeTabFromLayout } from "../../../stores/dbDockLayoutStore";
import {
  schedulePersistWorkspaceSession,
  flushPersistWorkspaceSession,
  useDbWorkspaceSessionStore,
} from "../../../stores/dbWorkspaceSessionStore";
import { useWorkspaceBottomDockStore } from "../../../stores/workspaceBottomDockStore";
import { useWorkspaceStore } from "../../../stores/workspaceStore";
import { useDbWorkspaceTabStore } from "../../../stores/dbWorkspaceTabStore";
import type { DbTabSnapshot } from "../../../stores/workspaceTabStore";
import { showToast } from "../../../stores/toastStore";
import type { useDatabasePanelTablePreview } from "./useDatabasePanelTablePreview";

type Translate = (key: string, params?: Record<string, string | number>) => string;
type SetWorkspaceTabs = Dispatch<SetStateAction<DbWorkspaceTab[]>>;
type SetSqlTabStates = ReturnType<typeof useDbWorkspaceTabStore.getState>["setSqlTabStates"];
type SetTablePreviews = ReturnType<typeof useDbWorkspaceTabStore.getState>["setTablePreviews"];
type SetTabDirtyRows = ReturnType<typeof useDbWorkspaceTabStore.getState>["setTabDirtyRows"];
type SetCommittingTabs = ReturnType<typeof useDbWorkspaceTabStore.getState>["setCommittingTabs"];
type SetTabModes = ReturnType<typeof useDbWorkspaceTabStore.getState>["setTabModes"];
type RemoveTabWorkspaceData = ReturnType<typeof useDbWorkspaceTabStore.getState>["removeTabWorkspaceData"];
type PushRecentClosedPanel = ReturnType<typeof useDbWorkspaceSessionStore.getState>["pushRecentClosedPanel"];
type RemoveRecentClosedPanel = ReturnType<typeof useDbWorkspaceSessionStore.getState>["removeRecentClosedPanel"];
type TablePreviewApi = ReturnType<typeof useDatabasePanelTablePreview>;

export type UseDatabasePanelDockTabsDeps = {
  setActiveConnIdIfChanged: (connId: string | null) => void;
  workspaceTabsRef: MutableRefObject<DbWorkspaceTab[]>;
  setActiveWorkspaceTabId: Dispatch<SetStateAction<string>>;
  setWorkspaceTabs: SetWorkspaceTabs;
  t: Translate;
  removeTabWorkspaceData: RemoveTabWorkspaceData;
  setTableDesignerStates: Dispatch<SetStateAction<Record<string, TableDesignerTabState>>>;
  setTabDirtyRows: SetTabDirtyRows;
  setCommittingTabs: SetCommittingTabs;
  pushRecentClosedPanel: PushRecentClosedPanel;
  removeRecentClosedPanel: RemoveRecentClosedPanel;
  setDirtySqlWorkspaceTabIds: Dispatch<SetStateAction<Set<string>>>;
  activeWorkspaceTabIdRef: MutableRefObject<string>;
  tableDesignerStatesRef: MutableRefObject<Record<string, TableDesignerTabState>>;
  setSqlTabStates: SetSqlTabStates;
  setTablePreviews: SetTablePreviews;
  connections: DbConnectionConfig[];
  loadTablePreview: TablePreviewApi["loadTablePreview"];
  refreshTabPreviewNow: TablePreviewApi["refreshTabPreviewNow"];
  goToPageNow: TablePreviewApi["goToPageNow"];
  setTablePageSize: TablePreviewApi["setTablePageSize"];
  setTableSort: TablePreviewApi["setTableSort"];
  setTableFilter: TablePreviewApi["setTableFilter"];
  commitTabDirty: TablePreviewApi["commitTabDirty"];
  rollbackTabDirty: TablePreviewApi["rollbackTabDirty"];
  workspaceTabs: DbWorkspaceTab[];
  setDockLayout: ReturnType<typeof useDbDockLayoutStore.getState>["setSavedLayout"];
  ctxMenu: { x: number; y: number; tabId: string; index: number } | null;
  setCtxMenu: Dispatch<SetStateAction<{ x: number; y: number; tabId: string; index: number } | null>>;
  setTabModes: SetTabModes;
};

export function useDatabasePanelDockTabs(deps: UseDatabasePanelDockTabsDeps) {
  const {
    setActiveConnIdIfChanged,
    workspaceTabsRef,
    setActiveWorkspaceTabId,
    setWorkspaceTabs,
    t,
    removeTabWorkspaceData,
    setTableDesignerStates,
    setTabDirtyRows,
    setCommittingTabs,
    pushRecentClosedPanel,
    removeRecentClosedPanel,
    setDirtySqlWorkspaceTabIds,
    activeWorkspaceTabIdRef,
    tableDesignerStatesRef,
    setSqlTabStates,
    setTablePreviews,
    connections,
    loadTablePreview,
    refreshTabPreviewNow,
    goToPageNow,
    setTablePageSize,
    setTableSort,
    setTableFilter,
    commitTabDirty,
    rollbackTabDirty,
    workspaceTabs,
    setDockLayout,
    ctxMenu,
    setCtxMenu,
    setTabModes,
  } = deps;

  const syncConnForTabId = useCallback((tabId: string) => {
    if (!tabId) {
      setActiveConnIdIfChanged(null);
      return;
    }
    const tab = workspaceTabsRef.current.find((item) => item.id === tabId);
    const connId = resolveConnIdForWorkspaceTab(tab, useDbWorkspaceTabStore.getState());
    if (connId) {
      setActiveConnIdIfChanged(connId);
    }
  }, [setActiveConnIdIfChanged]);

  const pushSidebarLinkageForTabId = useCallback((tabId: string) => {
    const tab = tabId
      ? workspaceTabsRef.current.find((item) => item.id === tabId)
      : undefined;
    const linkage = resolveDbSidebarLinkageFromTab(tab, useDbWorkspaceTabStore.getState());
    // 同步写侧栏联动（先于 startTransition 的 Tab 状态），保证树高亮跟手。
    // 禁止在 setState updater / render 中调用：会经 useSyncExternalStore 更新
    // DatabaseSchemaSidebar，触发 “Cannot update a component while rendering”。
    useDbSidebarLinkageStore.getState().setLinkage(linkage);
  }, []);

  const activateWorkspaceTab = useCallback(
    (tabId: string) => {
      pushSidebarLinkageForTabId(tabId);
      startTransition(() => {
        setActiveWorkspaceTabId((prev) => (prev === tabId ? prev : tabId));
        syncConnForTabId(tabId);
      });
    },
    [pushSidebarLinkageForTabId, syncConnForTabId],
  );

  const clearPreviewTabSlotData = useCallback(
    (tabId: string) => {
      removeTabWorkspaceData(tabId);
      setTableDesignerStates((prev) => {
        if (!(tabId in prev)) {
          return prev;
        }
        const next = { ...prev };
        delete next[tabId];
        return next;
      });
    },
    [removeTabWorkspaceData],
  );

  const promotePreviewTab = useCallback(
    (tabId: string) => {
      // 同步升格，避免双击时 startTransition 延迟导致又新建常驻 Tab
      setWorkspaceTabs((prev) =>
        prev.map((tab) => (tab.id === tabId ? { ...tab, preview: undefined } : tab)),
      );
      workspaceTabsRef.current = workspaceTabsRef.current.map((tab) =>
        tab.id === tabId ? { ...tab, preview: undefined } : tab,
      );
      patchDockTabPreviewMeta(tabId, false);
    },
    [setWorkspaceTabs],
  );

  /** 激活已有 Dock Tab；双击树节点时若当前为预览 Tab 则升格为常驻。 */
  const activateExistingDockTab = useCallback(
    (tabId: string, mode: SchemaDockOpenMode = "permanent") => {
      if (mode === "permanent") {
        const tab = workspaceTabsRef.current.find((item) => item.id === tabId);
        if (tab?.preview) {
          promotePreviewTab(tabId);
        }
      }
      activateWorkspaceTab(tabId);
    },
    [activateWorkspaceTab, promotePreviewTab],
  );

  const handleDockTabDoubleClick = useCallback(
    (tabId: string) => {
      const tab = workspaceTabsRef.current.find((item) => item.id === tabId);
      if (!tab?.preview) {
        return;
      }
      promotePreviewTab(tabId);
      activateWorkspaceTab(tabId);
    },
    [promotePreviewTab, activateWorkspaceTab],
  );

  const replacePreviewDockTab = useCallback(
    (previewTabId: string, nextTab: DbWorkspaceTab) => {
      const prevTab = workspaceTabsRef.current.find((tab) => tab.id === previewTabId);
      const inPlaceTableSwap = prevTab?.kind === "table" && nextTab.kind === "table";

      if (inPlaceTableSwap) {
        setTabDirtyRows((prev) => {
          if (!(previewTabId in prev)) {
            return prev;
          }
          const next = { ...prev };
          delete next[previewTabId];
          return next;
        });
        setCommittingTabs((prev) => {
          if (!prev.has(previewTabId)) {
            return prev;
          }
          const next = new Set(prev);
          next.delete(previewTabId);
          return next;
        });
      } else {
        clearPreviewTabSlotData(previewTabId);
      }
      patchDockTabPreviewMeta(previewTabId, true);
      const replaced = { ...nextTab, id: previewTabId, preview: true as const };
      setWorkspaceTabs((prev) => prev.map((tab) => (tab.id === previewTabId ? replaced : tab)));
      workspaceTabsRef.current = workspaceTabsRef.current.map((tab) =>
        tab.id === previewTabId ? replaced : tab,
      );
      activateWorkspaceTab(previewTabId);
      return previewTabId;
    },
    [
      clearPreviewTabSlotData,
      setWorkspaceTabs,
      activateWorkspaceTab,
      setTabDirtyRows,
      setCommittingTabs,
    ],
  );

  const openSyncTaskTab = useCallback(
    (task: SyncTask, runAfterLoad = false, mode: SchemaDockOpenMode = "permanent") => {
      const moduleTabs = workspaceTabsRef.current.filter(isModuleDockTab);
      const syncAction =
        task.kind === "schemaSync"
          ? t("database.workspace.tabAction.schemaSync")
          : t("database.workspace.tabAction.dataSync");
      const tabTemplate = makeSyncTaskWorkspaceTab(task, syncAction);
      const finish = (tabId: string) => {
        activateWorkspaceTab(tabId);
        useDbSyncTaskStore.getState().setActiveTaskId(task.id);
        useDbSyncTaskStore.getState().requestLoad(task.id, runAfterLoad);
      };
      const existingId = findTabIdForSyncTask(moduleTabs, task.id);
      if (existingId) {
        const existing = moduleTabs.find((item) => item.id === existingId);
        if (
          existing &&
          (existing.label !== tabTemplate.label ||
            (existing.kind === "toolbox" && existing.toolboxTab !== task.kind))
        ) {
          setWorkspaceTabs((prev) =>
            prev.map((item) =>
              item.id === existingId
                ? ({ ...item, label: tabTemplate.label, toolboxTab: task.kind } as DbWorkspaceTab)
                : item,
            ),
          );
        }
        if (mode === "permanent") {
          activateExistingDockTab(existingId, "permanent");
        } else {
          activateWorkspaceTab(existingId);
        }
        useDbSyncTaskStore.getState().setActiveTaskId(task.id);
        useDbSyncTaskStore.getState().requestLoad(task.id, runAfterLoad);
        return;
      }
      if (mode === "permanent") {
        setWorkspaceTabs((prev) =>
          prev.some((item) => item.id === tabTemplate.id) ? prev : [...prev, tabTemplate],
        );
        workspaceTabsRef.current = workspaceTabsRef.current.some((item) => item.id === tabTemplate.id)
          ? workspaceTabsRef.current
          : [...workspaceTabsRef.current, tabTemplate];
        finish(tabTemplate.id);
        return;
      }
      const previewTab = findPreviewDockTab(moduleTabs);
      if (previewTab?.kind === "toolbox" && previewTab.syncTaskId === task.id) {
        finish(previewTab.id);
        return;
      }
      if (previewTab) {
        finish(replacePreviewDockTab(previewTab.id, tabTemplate));
        return;
      }
      const tab = { ...tabTemplate, preview: true as const };
      patchDockTabPreviewMeta(tab.id, true);
      setWorkspaceTabs((prev) => [...prev, tab]);
      workspaceTabsRef.current = [...workspaceTabsRef.current, tab];
      finish(tab.id);
    },
    [activateExistingDockTab, activateWorkspaceTab, replacePreviewDockTab, setWorkspaceTabs, t],
  );

  const handleOpenSyncTask = useCallback(
    (task: SyncTask, mode: SchemaDockOpenMode = "permanent") => {
      openSyncTaskTab(task, false, mode);
    },
    [openSyncTaskTab],
  );

  const handleRunSyncTask = useCallback(
    (task: SyncTask) => {
      openSyncTaskTab(task, true);
    },
    [openSyncTaskTab],
  );

  const closeWorkspaceTabs = useCallback(
    (tabIds: string[]) => {
      const uniqueIds = [...new Set(tabIds.filter(Boolean))];
      if (uniqueIds.length === 0) return;

      const idSet = new Set(uniqueIds);
      const tabStoreSnapshot = useDbWorkspaceTabStore.getState();
      let closedAtSeq = Date.now();
      for (const tab of workspaceTabsRef.current) {
        if (!idSet.has(tab.id)) continue;
        if (tab.kind === "sql" && isScratchSqlTab(tab)) {
          const scratchState = tabStoreSnapshot.sqlTabStates[tab.id];
          if (scratchState) {
            useDbScratchQueryStore.getState().setDraft({
              sql: scratchState.sql,
              connId: scratchState.connId,
              database: scratchState.database,
              cursorOffset: scratchState.cursorOffset,
            });
          }
        }
        pushRecentClosedPanel(
          buildClosedPanelEntry({
            tab,
            sqlTabStates: tabStoreSnapshot.sqlTabStates,
            tablePreviews: tabStoreSnapshot.tablePreviews,
            tableDesignerStates: tableDesignerStatesRef.current,
            closedAt: closedAtSeq++,
          }),
        );
      }

      setDirtySqlWorkspaceTabIds((prev) => {
        const next = new Set(prev);
        let changed = false;
        for (const tabId of uniqueIds) {
          if (next.delete(tabId)) changed = true;
        }
        return changed ? next : prev;
      });

      // 先算好 fallback，再改 tabs：禁止在 setState updater 内 activate（会同步写侧栏 store）
      const prevTabs = workspaceTabsRef.current;
      const activeId = activeWorkspaceTabIdRef.current;
      let fallbackTabId: string | null = null;
      if (activeId && idSet.has(activeId)) {
        const nextTabs = prevTabs.filter((item) => !idSet.has(item.id));
        const oldIdx = prevTabs.findIndex((item) => item.id === activeId);
        fallbackTabId =
          nextTabs[Math.min(oldIdx, Math.max(0, nextTabs.length - 1))]?.id ?? "";
      }

      setWorkspaceTabs((prev) => prev.filter((item) => !idSet.has(item.id)));

      if (fallbackTabId !== null) {
        activateWorkspaceTab(fallbackTabId);
      }

      for (const tabId of uniqueIds) {
        removeTabWorkspaceData(tabId);
      }

      // 同步清理工作区 dock 中的幽灵 tab：源 tab 关闭后 dock 中的对应 tab
      // （payload kind: payload.id === tabId, mirrored kind: originPanelId === tabId）
      // 会因镜像快照被删除而变为空白。主动从 dock store 移除以避免幽灵 tab。
      const dockStore = useWorkspaceBottomDockStore.getState();
      for (const [wsId, tabs] of Object.entries(dockStore.tabsByWorkspace)) {
        if (!tabs) continue;
        const ghostTabIds = tabs
          .filter((t) => {
            if (t.kind === "payload" && t.payload?.module === "database") {
              return uniqueIds.includes(t.payload.id);
            }
            if (t.kind === "mirrored" && t.originScope === "database") {
              return t.originPanelId && uniqueIds.includes(t.originPanelId);
            }
            return false;
          })
          .map((t) => t.id);
        for (const ghostId of ghostTabIds) {
          const ws = useWorkspaceStore.getState().workspaces.find((w) => w.id === wsId);
          if (ws) {
            dockStore.removeTab(wsId, ws, ghostId, { skipRecentClosed: true });
          }
        }
      }

      setTableDesignerStates((prev) => {
        const next = { ...prev };
        let changed = false;
        for (const tabId of uniqueIds) {
          if (tabId in next) {
            delete next[tabId];
            changed = true;
          }
        }
        return changed ? next : prev;
      });

      const remainingModuleTabs = workspaceTabsRef.current.filter(isModuleDockTab);
      if (remainingModuleTabs.length === 0) {
        useDbDockLayoutStore.getState().setSavedLayout(null);
        schedulePersistWorkspaceSession(null);
        flushPersistWorkspaceSession();
      }
    },
    [pushRecentClosedPanel, activateWorkspaceTab, removeTabWorkspaceData],
  );

  const closeWorkspaceTab = useCallback(
    (tabId: string) => {
      closeWorkspaceTabs([tabId]);
    },
    [closeWorkspaceTabs],
  );

  const reopenRecentClosedPanel = useCallback(
    (entry: DbClosedPanelEntry) => {
      const { tab } = entry;

      if (tab.kind === "sql" && tab.sqlFileId) {
        const existing = findTabIdForSqlFile(workspaceTabsRef.current, tab.sqlFileId);
        if (existing) {
          activateWorkspaceTab(existing);
          removeRecentClosedPanel(entry.closedAt);
          return;
        }
        const file = useDbSqlFileStore.getState().getNode(tab.sqlFileId);
        if (!file || file.type !== "file") {
          removeRecentClosedPanel(entry.closedAt);
          return;
        }
      }

      if (tab.kind === "tree-chart" && tab.treeChartFileId) {
        const existing = findTabIdForTreeChartFile(workspaceTabsRef.current, tab.treeChartFileId);
        if (existing) {
          activateWorkspaceTab(existing);
          removeRecentClosedPanel(entry.closedAt);
          return;
        }
        const file = useDbTreeChartFileStore.getState().getNode(tab.treeChartFileId);
        if (!file) {
          removeRecentClosedPanel(entry.closedAt);
          return;
        }
      }

      if (tab.kind === "database") {
        const existing = findTabIdForDatabase(
          workspaceTabsRef.current,
          tab.connId,
          tab.dbName,
        );
        if (existing) {
          activateWorkspaceTab(existing);
          removeRecentClosedPanel(entry.closedAt);
          return;
        }
      }

      if (tab.kind === "connection") {
        const existing = findTabIdForConnection(workspaceTabsRef.current, tab.connId);
        if (existing) {
          activateWorkspaceTab(existing);
          removeRecentClosedPanel(entry.closedAt);
          return;
        }
      }

      if (tab.kind === "redis-query") {
        const existing = findTabIdForRedisQuery(
          workspaceTabsRef.current,
          tab.connId,
          tab.dbName,
        );
        if (existing) {
          activateWorkspaceTab(existing);
          removeRecentClosedPanel(entry.closedAt);
          return;
        }
      }

      if (tab.kind === "slow-query") {
        const existing = findTabIdForSlowQueryLog(workspaceTabsRef.current, tab.connId);
        if (existing) {
          activateWorkspaceTab(existing);
          removeRecentClosedPanel(entry.closedAt);
          return;
        }
      }

      if (tab.kind === "sql-exec-log") {
        const existing = findTabIdForSqlExecLog(workspaceTabsRef.current, tab.connId);
        if (existing) {
          activateWorkspaceTab(existing);
          removeRecentClosedPanel(entry.closedAt);
          return;
        }
      }

      if (tab.kind === "binlog") {
        const existing = findTabIdForBinlog(workspaceTabsRef.current, tab.connId);
        if (existing) {
          activateWorkspaceTab(existing);
          removeRecentClosedPanel(entry.closedAt);
          return;
        }
      }

      if (tab.kind === "designer") {
        const existing = findTabIdForDesigner(
          workspaceTabsRef.current,
          tab.connId,
          tab.dbName,
          tab.tableName,
        );
        if (existing) {
          activateWorkspaceTab(existing);
          removeRecentClosedPanel(entry.closedAt);
          return;
        }
      }

      if (tab.kind === "table") {
        const existing = findTabIdForTable(
          workspaceTabsRef.current.filter(isModuleDockTab),
          tab.connId,
          tab.dbName,
          tab.tableName,
        );
        if (existing) {
          activateWorkspaceTab(existing);
          removeRecentClosedPanel(entry.closedAt);
          return;
        }
      }

      if (workspaceTabsRef.current.some((item) => item.id === tab.id)) {
        activateWorkspaceTab(tab.id);
        removeRecentClosedPanel(entry.closedAt);
        return;
      }

      setWorkspaceTabs((prev) => [...prev, tab]);
      activateWorkspaceTab(tab.id);

      if (tab.kind === "sql" && entry.sqlTabState) {
        const snap = entry.sqlTabState;
        const base = snap
          ? restoreSqlTabStateFromSnapshot(snap)
          : createDefaultSqlTabState();
        setSqlTabStates((prev) => ({
          ...prev,
          [tab.id]:
            tab.sqlFileId != null
              ? resolveSqlTabStateFromFile(tab.sqlFileId, base)
              : base,
        }));
      }

      if (entry.tableDesignerState) {
        setTableDesignerStates((prev) => ({
          ...prev,
          [tab.id]: restoreTableDesignerStateFromSnapshot(entry.tableDesignerState!),
        }));
      }

      if (tab.kind === "table") {
        const previewState = entry.tablePreviewState;
        setTablePreviews((prev) => ({
          ...prev,
          [tab.id]: tablePreviewStateFromSnapshot(previewState, tab),
        }));
        const connection = connections.find((item) => item.id === tab.connId);
        if (connection) {
          void loadTablePreview(tab.id, connection, tab.dbName, tab.tableName);
        }
      }

      removeRecentClosedPanel(entry.closedAt);
    },
    [connections, loadTablePreview, removeRecentClosedPanel],
  );

  const hasDirty = useCallback(
    (tabId: string) =>
      Object.keys(useDbWorkspaceTabStore.getState().tabDirtyRows[tabId] ?? {}).length > 0,
    [],
  );


  const executeTabAction = useCallback(
    (action: {
      kind: "refresh" | "page" | "pageSize" | "close" | "sort" | "filter";
      tabId: string;
      page?: number;
      pageSize?: number;
      sort?: SortState | SortStates | null;
      filter?: RuleGroupType | null;
    }) => {
      if (action.kind === "refresh") {
        refreshTabPreviewNow(action.tabId);
      } else if (action.kind === "page") {
        goToPageNow(action.tabId, action.page ?? 0);
      } else if (action.kind === "pageSize") {
        setTablePageSize(action.tabId, action.pageSize ?? createDefaultTablePreviewState().pageSize);
      } else if (action.kind === "sort") {
        setTableSort(action.tabId, action.sort ?? null);
      } else if (action.kind === "filter") {
        setTableFilter(action.tabId, action.filter ?? null);
      } else {
        closeWorkspaceTab(action.tabId);
      }
    },
    [refreshTabPreviewNow, goToPageNow, setTablePageSize, setTableSort, setTableFilter, closeWorkspaceTab],
  );

  const requestTabAction = useCallback(
    (action: {
      kind: "refresh" | "page" | "pageSize" | "close" | "sort" | "filter";
      tabId: string;
      page?: number;
      pageSize?: number;
      sort?: SortState | SortStates | null;
      filter?: RuleGroupType | null;
    }) => {
      void (async () => {
        if (action.kind === "close" && hasDirty(action.tabId)) {
          const tabState = useDbWorkspaceTabStore.getState();
          const dirty = tabState.tabDirtyRows[action.tabId];
          const preview = tabState.tablePreviews[action.tabId];
          const colMeta = tabState.tableColumnMeta[action.tabId];
          const dirtyCount = Object.keys(dirty ?? {}).length;
          const commit = await appConfirm(
            t("database.results.dirtyMessage", { count: dirtyCount }),
            t("database.results.dirtyTitle"),
            {
              confirmLabel: t("database.results.dirtyCommit"),
              cancelLabel: t("database.results.dirtyRollback"),
              kind: "warning",
            },
          );

          // 关 Tab 前拷贝提交所需快照（关闭后 store 数据会被清掉）
          const connection =
            preview?.connId != null
              ? connections.find((c) => c.id === preview.connId)
              : undefined;
          const commitSnapshot =
            commit && dirty && preview?.connId && preview.dbName && preview.tableName && colMeta && connection
              ? {
                  dirty: structuredClone(dirty),
                  preview: {
                    connId: preview.connId,
                    dbName: preview.dbName,
                    tableName: preview.tableName,
                  },
                  colMeta: [...colMeta],
                  connection,
                }
              : null;

          if (!commit) {
            rollbackTabDirty(action.tabId);
          }

          // 先关页面，再后台提交（避免卡在 dock 上）
          executeTabAction(action);

          if (commitSnapshot) {
            void commitTabDirty(action.tabId, commitSnapshot).catch((err) => {
              showToast(
                t("database.results.dirtyCommitFailed", {
                  message: err instanceof Error ? err.message : String(err),
                }),
              );
            });
          }
          return;
        }

        if (hasDirty(action.tabId) && action.kind !== "close") {
          const dirtyCount = Object.keys(
            useDbWorkspaceTabStore.getState().tabDirtyRows[action.tabId] ?? {},
          ).length;
          const commit = await appConfirm(
            t("database.results.dirtyMessage", { count: dirtyCount }),
            t("database.results.dirtyTitle"),
            {
              confirmLabel: t("database.results.dirtyCommit"),
              cancelLabel: t("database.results.dirtyRollback"),
              kind: "warning",
            },
          );
          if (commit) {
            try {
              await commitTabDirty(action.tabId);
            } catch {
              return;
            }
          } else {
            rollbackTabDirty(action.tabId);
          }
        }
        executeTabAction(action);
      })();
    },
    [hasDirty, executeTabAction, commitTabDirty, rollbackTabDirty, connections, t],
  );
  const renameWorkspaceTab = useCallback((tabId: string, label: string) => {
    const nextLabel = label.trim();
    if (!nextLabel) return;
    setWorkspaceTabs((prev) =>
      prev.map((tab) => (tab.id === tabId ? { ...tab, label: nextLabel } : tab)),
    );
  }, []);

  const handleRenameTab = useCallback(
    async (tabId: string) => {
      const tab = workspaceTabs.find((item) => item.id === tabId);
      if (!tab) return;

      const name = await quickInput({
        title: t("database.workspace.renameTabTitle"),
        subtitle: t("shell.topbar.rename"),
        placeholder: t("database.workspace.renameTabPlaceholder"),
        defaultValue: tab.label,
        validate: (value) => {
          if (!value.trim()) {
            return t("database.workspace.renameTabRequired");
          }
          return null;
        },
      });

      if (name) {
        renameWorkspaceTab(tabId, name);
      }
    },
    [workspaceTabs, t, renameWorkspaceTab],
  );

  const performMoveTabToWorkspace = useCallback(
    (tabId: string, targetWorkspaceId: string) => {
      if (!targetWorkspaceId) return;
      const ctxTab = workspaceTabs.find((tab) => tab.id === tabId);
      if (!ctxTab || ctxTab.workspaceOnly) return;

      const prevTabs = workspaceTabsRef.current;
      const idx = prevTabs.findIndex((item) => item.id === ctxTab.id);
      const closingActive = activeWorkspaceTabIdRef.current === ctxTab.id;

      setWorkspaceTabs((prev) =>
        prev.map((t) => (t.id === ctxTab.id ? { ...t, workspaceOnly: true } : t)),
      );

      const currentLayout = useDbDockLayoutStore.getState().savedLayout;
      setDockLayout(removeTabFromLayout(currentLayout, ctxTab.id));

      if (closingActive) {
        const nextTabs = prevTabs.filter((item) => item.id !== ctxTab.id && !item.workspaceOnly);
        const fallback = nextTabs[Math.min(idx, Math.max(0, nextTabs.length - 1))];
        activateWorkspaceTab(fallback?.id ?? "");
      }

      const tabStoreState = useDbWorkspaceTabStore.getState();
      void deliverSnapshotToWorkspace(
        targetWorkspaceId,
        dbTabToSnapshot(ctxTab, tabStoreState.tabModes[ctxTab.id]),
      );
      setCtxMenu(null);
    },
    [workspaceTabs, setDockLayout, activateWorkspaceTab],
  );

  const handlePanelTransferredToWorkspace = useCallback(
    (tabId: string, targetScope: string) => {
      if (!targetScope.startsWith("workspace-bottom-")) return;
      const ctxTab = workspaceTabsRef.current.find((tab) => tab.id === tabId);
      if (!ctxTab) return;
      const prevTabs = workspaceTabsRef.current;
      const idx = prevTabs.findIndex((item) => item.id === ctxTab.id);
      const closingActive = activeWorkspaceTabIdRef.current === ctxTab.id;

      setWorkspaceTabs((prev) =>
        prev.map((t) => (t.id === ctxTab.id ? { ...t, workspaceOnly: true } : t)),
      );

      const currentLayout = useDbDockLayoutStore.getState().savedLayout;
      setDockLayout(removeTabFromLayout(currentLayout, ctxTab.id));

      if (closingActive) {
        const nextTabs = prevTabs.filter((item) => item.id !== ctxTab.id && !item.workspaceOnly);
        const fallback = nextTabs[Math.min(idx, Math.max(0, nextTabs.length - 1))];
        activateWorkspaceTab(fallback?.id ?? "");
      }
    },
    [activateWorkspaceTab, setDockLayout],
  );
  useEffect(() => {
    return subscribeDockviewTransfer((meta) => {
      if (!meta.newPanelId.startsWith("database:")) return;
      if (!meta.originScope.startsWith("workspace-bottom-")) return;

      // 从 originPanelId 中解析出原始数据库 tab id
      // workspace dock 中 panel id 格式: "workspace-bottom-{wsId}:{原始tabId}"
      const prefix = `${meta.originScope}:`;
      const originalTabId = meta.originPanelId.startsWith(prefix)
        ? meta.originPanelId.slice(prefix.length)
        : meta.originPanelId;

      const ctxTab = workspaceTabsRef.current.find((tab) => tab.id === originalTabId);
      if (!ctxTab) return;

      // 恢复 workspaceOnly = false，让 tab 重新在主面板可见
      if (ctxTab.workspaceOnly) {
        setWorkspaceTabs((prev) =>
          prev.map((t) => (t.id === originalTabId ? { ...t, workspaceOnly: false } : t)),
        );
      }
      activateWorkspaceTab(originalTabId);
      requestAnimationFrame(() => relayoutDockviewInstances("database"));
    });
  }, [activateWorkspaceTab, setWorkspaceTabs]);
  const handleContextAction = useCallback(
    (action: TabContextMenuAction) => {
      if (!ctxMenu) return;
      const { tabId } = ctxMenu;
      const visibleTabs = workspaceTabs.filter((tab) => !tab.workspaceOnly);
      const idx = visibleTabs.findIndex((tab) => tab.id === tabId);

      if (action === "rename") {
        setCtxMenu(null);
        void handleRenameTab(tabId);
        return;
      }

      if (action === "close") {
        closeWorkspaceTab(tabId);
      } else if (action === "closeLeft") {
        if (idx > 0) {
          closeWorkspaceTabs(visibleTabs.slice(0, idx).map((tab) => tab.id));
        }
      } else if (action === "closeRight") {
        if (idx >= 0 && idx < visibleTabs.length - 1) {
          closeWorkspaceTabs(visibleTabs.slice(idx + 1).map((tab) => tab.id));
        }
      } else if (action === "closeOthers") {
        if (idx >= 0) {
          closeWorkspaceTabs(visibleTabs.filter((tab) => tab.id !== tabId).map((tab) => tab.id));
        }
      } else if (action === "closeAll") {
        closeWorkspaceTabs(visibleTabs.map((tab) => tab.id));
      }
      setCtxMenu(null);
    },
    [ctxMenu, workspaceTabs, closeWorkspaceTab, closeWorkspaceTabs, handleRenameTab, setDockLayout],
  );
  useEffect(() => {
    const handleCloseEvent = (e: Event) => {
      const customEvent = e as CustomEvent<string>;
      closeWorkspaceTab(customEvent.detail);
    };
    window.addEventListener("omnipanel:close-db-workspace-tab", handleCloseEvent);
    return () => {
      window.removeEventListener("omnipanel:close-db-workspace-tab", handleCloseEvent);
    };
  }, [closeWorkspaceTab]);

  useEffect(() => {
    const handleRestoreEvent = (e: Event) => {
      const detail = (e as CustomEvent<{ snapshot: DbTabSnapshot }>).detail;
      const snapshot = detail?.snapshot;
      if (!snapshot || snapshot.module !== "database") return;

      const recentEntry = useDbWorkspaceSessionStore
        .getState()
        .recentClosedPanels.find((item) => item.tab.id === snapshot.id);
      if (recentEntry) {
        reopenRecentClosedPanel(recentEntry);
        return;
      }

      const tab = { ...snapshot.tab, workspaceOnly: true } as DbWorkspaceTab;
      if (workspaceTabsRef.current.some((item) => item.id === tab.id)) {
        activateWorkspaceTab(tab.id);
        return;
      }

      setWorkspaceTabs((prev) => [...prev, tab]);
      activateWorkspaceTab(tab.id);
      if (snapshot.tabMode) {
        setTabModes((prev) => ({ ...prev, [tab.id]: snapshot.tabMode! }));
      }
    };
    window.addEventListener("omnipanel:restore-db-workspace-tab", handleRestoreEvent);
    return () => {
      window.removeEventListener("omnipanel:restore-db-workspace-tab", handleRestoreEvent);
    };
  }, [reopenRecentClosedPanel, activateWorkspaceTab, setTabModes]);
  const handleDockTabContextMenu = useCallback(
    (event: ReactMouseEvent, tabId: string, index: number) => {
      setCtxMenu({ x: event.clientX, y: event.clientY, tabId, index });
    },
    [],
  );
  const handleCloseDockTab = useCallback(
    (tabId: string) => requestTabAction({ kind: "close", tabId }),
    [requestTabAction],
  );

  useEffect(() => {
    registerDatabaseTabCloser(handleCloseDockTab);
    return () => registerDatabaseTabCloser(null);
  }, [handleCloseDockTab]);

  return {
    syncConnForTabId,
    pushSidebarLinkageForTabId,
    activateWorkspaceTab,
    openSyncTaskTab,
    handleOpenSyncTask,
    handleRunSyncTask,
    clearPreviewTabSlotData,
    promotePreviewTab,
    activateExistingDockTab,
    handleDockTabDoubleClick,
    replacePreviewDockTab,
    closeWorkspaceTabs,
    closeWorkspaceTab,
    reopenRecentClosedPanel,
    hasDirty,
    executeTabAction,
    requestTabAction,
    renameWorkspaceTab,
    handleRenameTab,
    performMoveTabToWorkspace,
    handlePanelTransferredToWorkspace,
    handleContextAction,
    handleDockTabContextMenu,
    handleCloseDockTab,
  };
}
