import { useMemo, useRef } from "react";

import type { DbWorkspaceSharedContextValue } from "../../contexts/DbWorkspaceContext.types";
import { useDbWorkspaceTabStore } from "../../stores/dbWorkspaceTabStore";

export interface DatabaseWorkspaceContextData {
  workspaceTabs: DbWorkspaceSharedContextValue["tabs"];
  connectionsLoading: boolean;
  sqlConnections: DbWorkspaceSharedContextValue["sqlConnections"];
  groupConnections: DbWorkspaceSharedContextValue["groupConnections"];
  databasesByConnId: DbWorkspaceSharedContextValue["databasesByConnId"];
  schemaByKey: DbWorkspaceSharedContextValue["schemaByKey"];
  schemaLoadingKey: DbWorkspaceSharedContextValue["schemaLoadingKey"];
}

export interface DatabaseWorkspaceContextHandlers {
  requestTabAction: DbWorkspaceSharedContextValue["requestTabAction"];
  runQuery: DbWorkspaceSharedContextValue["runQuery"];
  cancelQuery: DbWorkspaceSharedContextValue["cancelQuery"];
  goToQueryResultPage: DbWorkspaceSharedContextValue["goToQueryResultPage"];
  updateSqlTabState: DbWorkspaceSharedContextValue["updateSqlTabState"];
  closeSqlResultSession: DbWorkspaceSharedContextValue["closeSqlResultSession"];
  setSqlResultSessionPinned: DbWorkspaceSharedContextValue["setSqlResultSessionPinned"];
  refreshTablePreview: DbWorkspaceSharedContextValue["refreshTablePreview"];
  goToPage: DbWorkspaceSharedContextValue["goToPage"];
  setTableSort: DbWorkspaceSharedContextValue["setTableSort"];
  setTableFilter: DbWorkspaceSharedContextValue["setTableFilter"];
  setTableGridView: DbWorkspaceSharedContextValue["setTableGridView"];
  handleCellCommit: DbWorkspaceSharedContextValue["handleCellCommit"];
  handleRowEdit: DbWorkspaceSharedContextValue["handleRowEdit"];
  handleCellSetNull: DbWorkspaceSharedContextValue["handleCellSetNull"];
  handleRowNew: DbWorkspaceSharedContextValue["handleRowNew"];
  handleRowPaste: DbWorkspaceSharedContextValue["handleRowPaste"];
  handleRowsDelete: DbWorkspaceSharedContextValue["handleRowsDelete"];
  resolveConnection: DbWorkspaceSharedContextValue["resolveConnection"];
  handleSelectTable: DbWorkspaceSharedContextValue["selectTable"];
  handleSelectDatabase: DbWorkspaceSharedContextValue["selectDatabase"];
  handleDesignTable: DbWorkspaceSharedContextValue["openTableDesigner"];
  openTableQuery: DbWorkspaceSharedContextValue["openTableQuery"];
  commitTabDirty: DbWorkspaceSharedContextValue["commitTabDirty"];
  rollbackTabDirty: DbWorkspaceSharedContextValue["rollbackTabDirty"];
  undoTabDirty: DbWorkspaceSharedContextValue["undoTabDirty"];
  redoTabDirty: DbWorkspaceSharedContextValue["redoTabDirty"];
  openExportMenu: DbWorkspaceSharedContextValue["openExportMenu"];
  resolveSqlTabConnection: DbWorkspaceSharedContextValue["resolveSqlTabConnection"];
  getSqlTabDatabases: DbWorkspaceSharedContextValue["getSqlTabDatabases"];
  getSqlCompletionSchemas: DbWorkspaceSharedContextValue["getSqlCompletionSchemas"];
  connectionForSqlTab: DbWorkspaceSharedContextValue["connectionForSqlTab"];
  setSqlTabConnection: DbWorkspaceSharedContextValue["setSqlTabConnection"];
  rowsToRecord: DbWorkspaceSharedContextValue["rowsToRecord"];
  tabModeToEditorOpenMode: DbWorkspaceSharedContextValue["tabModeToEditorOpenMode"];
  saveSqlTab: DbWorkspaceSharedContextValue["saveSqlTab"];
  isSqlTabDirty: DbWorkspaceSharedContextValue["isSqlTabDirty"];
}

/** 通过 ref 持有 handler，避免 Context value 因函数引用变化而频繁重建。 */
export function useDatabaseWorkspaceContextValue(
  data: DatabaseWorkspaceContextData,
  handlers: DatabaseWorkspaceContextHandlers,
): DbWorkspaceSharedContextValue {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  return useMemo(
    () => ({
      tabs: data.workspaceTabs,
      closeTab: (tabId: string) =>
        handlersRef.current.requestTabAction({ kind: "close", tabId }),
      runQuery: (...args) => handlersRef.current.runQuery(...args),
      cancelQuery: (...args) => handlersRef.current.cancelQuery(...args),
      goToQueryResultPage: (...args) => handlersRef.current.goToQueryResultPage(...args),
      updateSqlTabState: (...args) => handlersRef.current.updateSqlTabState(...args),
      closeSqlResultSession: (...args) => handlersRef.current.closeSqlResultSession(...args),
      setSqlResultSessionPinned: (...args) =>
        handlersRef.current.setSqlResultSessionPinned(...args),
      refreshTablePreview: (...args) => handlersRef.current.refreshTablePreview(...args),
      goToPage: (...args) => handlersRef.current.goToPage(...args),
      requestTabAction: (...args) => handlersRef.current.requestTabAction(...args),
      setTableSort: (...args) => handlersRef.current.setTableSort(...args),
      setTableFilter: (...args) => handlersRef.current.setTableFilter(...args),
      setTableGridView: (...args) => handlersRef.current.setTableGridView(...args),
      handleCellCommit: (...args) => handlersRef.current.handleCellCommit(...args),
      handleRowEdit: (...args) => handlersRef.current.handleRowEdit(...args),
      handleCellSetNull: (...args) => handlersRef.current.handleCellSetNull(...args),
      handleRowNew: (...args) => handlersRef.current.handleRowNew(...args),
      handleRowPaste: (...args) => handlersRef.current.handleRowPaste(...args),
      handleRowsDelete: (...args) => handlersRef.current.handleRowsDelete(...args),
      resolveConnection: (...args) => handlersRef.current.resolveConnection(...args),
      connectionsLoading: data.connectionsLoading,
      selectTable: (...args) => handlersRef.current.handleSelectTable(...args),
      selectDatabase: (...args) => handlersRef.current.handleSelectDatabase(...args),
      openTableDesigner: (...args) => handlersRef.current.handleDesignTable(...args),
      openTableQuery: (...args) => handlersRef.current.openTableQuery(...args),
      setTabMode: (id, mode) => useDbWorkspaceTabStore.getState().setTabMode(id, mode),
      commitTabDirty: (...args) => handlersRef.current.commitTabDirty(...args),
      rollbackTabDirty: (...args) => handlersRef.current.rollbackTabDirty(...args),
      undoTabDirty: (...args) => handlersRef.current.undoTabDirty(...args),
      redoTabDirty: (...args) => handlersRef.current.redoTabDirty(...args),
      openExportMenu: (...args) => handlersRef.current.openExportMenu(...args),
      sqlConnections: data.sqlConnections,
      groupConnections: data.groupConnections,
      databasesByConnId: data.databasesByConnId,
      schemaByKey: data.schemaByKey,
      schemaLoadingKey: data.schemaLoadingKey,
      resolveSqlTabConnection: (...args) => handlersRef.current.resolveSqlTabConnection(...args),
      getSqlTabDatabases: (...args) => handlersRef.current.getSqlTabDatabases(...args),
      getSqlCompletionSchemas: (...args) => handlersRef.current.getSqlCompletionSchemas(...args),
      connectionForSqlTab: (...args) => handlersRef.current.connectionForSqlTab(...args),
      setSqlTabConnection: (...args) => handlersRef.current.setSqlTabConnection(...args),
      rowsToRecord: handlersRef.current.rowsToRecord,
      tabModeToEditorOpenMode: handlersRef.current.tabModeToEditorOpenMode,
      saveSqlTab: (...args) => handlersRef.current.saveSqlTab(...args),
      isSqlTabDirty: (...args) => handlersRef.current.isSqlTabDirty(...args),
    }),
    [
      data.workspaceTabs,
      data.connectionsLoading,
      data.sqlConnections,
      data.groupConnections,
      data.databasesByConnId,
      data.schemaByKey,
      data.schemaLoadingKey,
    ],
  );
}

export function useDatabaseActiveTabContextValue(
  activeTabId: string,
  activateWorkspaceTab: (tabId: string) => void,
) {
  const activateRef = useRef(activateWorkspaceTab);
  activateRef.current = activateWorkspaceTab;

  return useMemo(
    () => ({
      activeTabId,
      setActiveTabId: (tabId: string) => activateRef.current(tabId),
    }),
    [activeTabId],
  );
}
