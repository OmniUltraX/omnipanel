import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  useDbTabWorkspaceSlice,
  EMPTY_TAB_DIRTY_ROWS,
  type DbTabWorkspaceSlice,
} from "../stores/dbWorkspaceTabStore";
import type {
  DbWorkspaceSharedContextValue,
  DbWorkspaceActiveTabContextValue,
  DbWorkspaceTabDataContextValue,
  DbWorkspaceMirrorContextValue,
  DbWorkspaceProvidersProps,
} from "./DbWorkspaceContext.types";

export type {
  DbTabAction,
  DbWorkspaceSharedContextValue,
  DbWorkspaceActiveTabContextValue,
  DbWorkspaceProvidersProps,
  DbWorkspaceTabDataContextValue,
  DbWorkspaceMirrorContextValue,
  DbWorkspaceContextValue,
} from "./DbWorkspaceContext.types";

const StateCtx = createContext<DbWorkspaceSharedContextValue | null>(null);
const ActiveTabCtx = createContext<DbWorkspaceActiveTabContextValue | null>(null);
/** 底部镜像 Tab 注入的 Tab 级数据（主面板走 Zustand store）。 */
const MirrorTabDataCtx = createContext<DbWorkspaceTabDataContextValue | null>(null);

function splitMirrorContextValue(value: DbWorkspaceMirrorContextValue): {
  state: DbWorkspaceSharedContextValue;
  activeTab: DbWorkspaceActiveTabContextValue;
  tabData: DbWorkspaceTabDataContextValue;
} {
  const {
    activeTabId,
    setActiveTabId,
    activeTableKey: _activeTableKey,
    sqlTabStates,
    tablePreviews,
    tableColumnMeta,
    tabModes,
    tabDirtyRows,
    committingTabs,
    ...state
  } = value;
  return {
    state,
    activeTab: { activeTabId, setActiveTabId },
    tabData: {
      sqlTabStates,
      tablePreviews,
      tableColumnMeta,
      tabModes,
      tabDirtyRows,
      committingTabs,
    },
  };
}

export function DbWorkspaceProviders({
  state,
  activeTab,
  children,
}: DbWorkspaceProvidersProps) {
  return (
    <StateCtx.Provider value={state}>
      <ActiveTabCtx.Provider value={activeTab}>{children}</ActiveTabCtx.Provider>
    </StateCtx.Provider>
  );
}

/** 镜像 Tab 等场景：从完整快照注入双 Context。 */
export function DbWorkspaceMirrorProvider({
  value,
  children,
}: {
  value: DbWorkspaceMirrorContextValue;
  children: ReactNode;
}) {
  const { state, activeTab, tabData } = splitMirrorContextValue(value);
  return (
    <MirrorTabDataCtx.Provider value={tabData}>
      <DbWorkspaceProviders state={state} activeTab={activeTab}>
        {children}
      </DbWorkspaceProviders>
    </MirrorTabDataCtx.Provider>
  );
}

/** @deprecated 请使用 DbWorkspaceProviders；保留以兼容镜像注入。 */
export function DbWorkspaceProvider({
  value,
  children,
}: {
  value: DbWorkspaceMirrorContextValue;
  children: ReactNode;
}) {
  return <DbWorkspaceMirrorProvider value={value}>{children}</DbWorkspaceMirrorProvider>;
}

export function useDbWorkspace(): DbWorkspaceSharedContextValue {
  const v = useContext(StateCtx);
  if (!v) {
    throw new Error("useDbWorkspace must be used inside DbWorkspaceProviders");
  }
  return v;
}

export function useDbWorkspaceActiveTab(): DbWorkspaceActiveTabContextValue {
  const v = useContext(ActiveTabCtx);
  if (!v) {
    throw new Error("useDbWorkspaceActiveTab must be used inside DbWorkspaceProviders");
  }
  return v;
}

export function useDbWorkspaceActiveTabId(): string {
  return useDbWorkspaceActiveTab().activeTabId;
}

/** 主面板走 store；镜像 Tab 走 MirrorTabDataCtx。 */
export function useDbTabWorkspaceSliceOrMirror(tabId: string): DbTabWorkspaceSlice {
  const mirrorTabData = useContext(MirrorTabDataCtx);
  const storeSlice = useDbTabWorkspaceSlice(tabId);

  const mirrorSlice = useMemo((): DbTabWorkspaceSlice | null => {
    if (!mirrorTabData) {
      return null;
    }
    return {
      sqlTabState: mirrorTabData.sqlTabStates[tabId],
      tablePreview: mirrorTabData.tablePreviews[tabId],
      tableColumnMeta: mirrorTabData.tableColumnMeta[tabId],
      tabMode: mirrorTabData.tabModes[tabId] ?? "sql",
      tabDirtyRows: mirrorTabData.tabDirtyRows[tabId] ?? EMPTY_TAB_DIRTY_ROWS,
      isCommitting: mirrorTabData.committingTabs.has(tabId),
    };
  }, [mirrorTabData, tabId]);

  return mirrorSlice ?? storeSlice;
}
