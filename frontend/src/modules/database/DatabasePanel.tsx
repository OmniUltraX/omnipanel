import { ModuleWorkspaceLayout } from "../../components/workspace";
import { ModuleLeftHeaderActions } from "../../components/ai/ModuleLeftHeaderActions";
import { DatabaseSchemaSidebar } from "./schema/DatabaseSchemaSidebar";
import { DatabaseModuleContextBridge } from "./ai";
import { DbSchemaProvider } from "./schema/DbSchemaContext";
import { DatabaseDialogsHost } from "./workspace/DatabaseDialogsHost";
import { DatabaseWorkspaceDock } from "./workspace/DatabaseWorkspaceDock";
import { ContextMenu } from "../../components/ui/menu";
import { buildTabCloseMenuItems } from "../../components/ui/menu";
import { DockTabIcon } from "../../components/dock/DockTabIcon";
import { CsvExportDialog } from "./workspace/CsvExportDialog";
import { isScratchSqlTab } from "./workspace/workspaceTabs";
import { DatabaseTableEditorHost } from "./workspace/DatabaseTableEditorHost";
import { DbWorkspaceProviders } from "../../contexts/DbWorkspaceContext";
import { DbSidebarLinkageProvider } from "./schema/DbSidebarLinkageContext";
import { useDatabasePanelModel } from "./panel/useDatabasePanelModel";

export function DatabasePanel() {
  const {
    activeConnId,
    activeTabContextValue,
    activeSqlFileId,
    activeSyncTaskId,
    activeTreeChartFileId,
    activeWorkspaceId,
    activeWorkspaceTab,
    buildExportMenuItems,
    buildSchemaContextMenuItems,
    connections,
    connectionsLoading,
    createDbDialog,
    csvExportDialog,
    ctxMenu,
    databaseModuleContext,
    dialogOpen,
    dockTabs,
    editingConnection,
    editorHostTabId,
    editorTabDirtyRows,
    editorTableColumnMeta,
    exportDialog,
    exportMenu,
    exportSubmitting,
    handleCloseDockTab,
    handleConfirmExportDatabase,
    handleConfirmImportDatabase,
    handleContextAction,
    handleCreateConnection,
    handleDeleteConnection,
    handleDockTabContextMenu,
    handleDockTabDoubleClick,
    handleImportNavicat,
    handleNewSqlQuery,
    handleNewTreeChart,
    handleOpenScratchQuery,
    openSqlExecLog,
    handleOpenSyncTask,
    handlePanelTransferredToWorkspace,
    handleRowSave,
    handleRunSyncTask,
    handleSchemaCacheConnectionPatched,
    handleSelectConnection,
    handleSelectDatabase,
    handleSelectTable,
    importDialog,
    importPreview,
    importSubmitting,
    isActiveRoute,
    moduleLive,
    moduleSoftRefreshKey,
    openSqlFile,
    openTreeChartFile,
    panelContentKeysByTab,
    performMoveTabToWorkspace,
    recentClosedActionItems,
    refreshConnDatabases,
    refreshConnections,
    renderDockPanel,
    rowEdit,
    schemaContextValue,
    schemaRefreshToken,
    setActiveConnId,
    setCreateDbDialog,
    setCsvExportDialog,
    setCtxMenu,
    setDialogOpen,
    setEditingConnection,
    setExportDialog,
    setExportMenu,
    setImportDialog,
    setImportPreview,
    setRowEdit,
    setSchemaRefreshToken,
    sidebarConnections,
    sqlQueryBindingContext,
    t,
    workspaceInitialized,
    workspaceStateValue,
    workspaceTabs,
    workspaces,
  } = useDatabasePanelModel();

  return (
    <>
    <DatabaseModuleContextBridge active={moduleLive} context={databaseModuleContext} />
    <DbSidebarLinkageProvider>
    <DbWorkspaceProviders
      state={workspaceStateValue}
      activeTab={activeTabContextValue}
      syncActiveTabStore
    >
    <DbSchemaProvider value={schemaContextValue}>
    <ModuleWorkspaceLayout
      className="db-module-layout"
      leftColumnTitle={t("routes.database")}
      leftPreset="schema"
      tagModuleKey="database"
      leftHeaderActions={<ModuleLeftHeaderActions moduleKey="database" />}
      leftIconRail={
        <div className="module-mode-icon-rail">
          <button
            type="button"
            className={`module-mode-icon-rail__btn${
              activeWorkspaceTab?.kind === "sql" && isScratchSqlTab(activeWorkspaceTab)
                ? " module-mode-icon-rail__btn--active"
                : ""
            }`}
            title={t("database.workspace.scratchQuery")}
            aria-label={t("database.workspace.scratchQuery")}
            onClick={handleOpenScratchQuery}
          >
            <DockTabIcon kind="sql" />
          </button>
          <button
            type="button"
            className={`module-mode-icon-rail__btn${
              activeWorkspaceTab?.kind === "sql-exec-log" ? " module-mode-icon-rail__btn--active" : ""
            }`}
            title={t("database.sqlExec.connLog")}
            aria-label={t("database.sqlExec.connLog")}
            onClick={() => {
              const connId = activeConnId;
              if (!connId) return;
              const connection = connections.find((item) => item.id === connId);
              if (!connection) return;
              openSqlExecLog(connection);
            }}
          >
            <DockTabIcon kind="database" />
          </button>
        </div>
      }
      leftSidebar={
        <DatabaseSchemaSidebar
          onCreateConnection={handleCreateConnection}
          onNewSqlQuery={handleNewSqlQuery}
          onImportNavicat={handleImportNavicat}
          onSelectConnection={handleSelectConnection}
          onOpenSqlFile={openSqlFile}
          onNewTreeChart={handleNewTreeChart}
          onOpenTreeChartFile={openTreeChartFile}
          activeSqlFileId={activeSqlFileId}
          activeTreeChartFileId={activeTreeChartFileId}
          activeSyncTaskId={activeSyncTaskId}
          onOpenSyncTask={handleOpenSyncTask}
          onRunSyncTask={handleRunSyncTask}
          onSelectTable={handleSelectTable}
          onSelectDatabase={handleSelectDatabase}
          buildSchemaContextMenuItems={buildSchemaContextMenuItems}
          onDeleteConnections={handleDeleteConnection}
          onSchemaCacheConnectionPatched={handleSchemaCacheConnectionPatched}
          refreshToken={schemaRefreshToken}
          connectionConfigs={sidebarConnections}
          connectionsReady={!connectionsLoading || connections.length > 0}
          sqlQueryBindingContext={sqlQueryBindingContext}
        />
      }
    >
      <div className="db-workspace-drop-zone">
        {!workspaceInitialized ? null : (
          <DatabaseWorkspaceDock
            workspaceInitialized={workspaceInitialized}
            dockTabs={dockTabs}
            moduleTitle={t("routes.database")}
            enabled={moduleLive}
            contentSuspended={!moduleLive}
            windowControl
            onCloseTab={handleCloseDockTab}
            renderDockPanel={renderDockPanel}
            softRefreshKey={moduleSoftRefreshKey}
            panelContentKeysByTab={panelContentKeysByTab}
            onTabContextMenu={handleDockTabContextMenu}
            onTabDoubleClick={handleDockTabDoubleClick}
            onPanelTransferredOut={handlePanelTransferredToWorkspace}
            recentClosedActionItems={recentClosedActionItems}
            emptyPrompt={t("database.workspace.emptyTabs")}
            recentClosedTitle={t("database.workspace.recentClosed")}
          />
        )}
      </div>
    </ModuleWorkspaceLayout>
    </DbSchemaProvider>
    <DatabaseDialogsHost
      connections={connections}
      createDbDialog={createDbDialog}
      onCloseCreateDb={() => setCreateDbDialog(null)}
      onCreatedDatabase={(connId) => {
        refreshConnDatabases(connId);
        setActiveConnId(connId);
      }}
      exportDialog={exportDialog}
      exportSubmitting={exportSubmitting}
      onCloseExport={() => setExportDialog(null)}
      onConfirmExport={(destination) => {
        void handleConfirmExportDatabase(destination);
      }}
      importDialog={importDialog}
      importSubmitting={importSubmitting}
      onCloseImport={() => setImportDialog(null)}
      onConfirmImport={(source) => {
        void handleConfirmImportDatabase(source);
      }}
      dialogOpen={dialogOpen}
      editingConnection={editingConnection}
      onCloseConnectionDialog={() => {
        setDialogOpen(false);
        setEditingConnection(null);
      }}
      onSavedConnection={() => {
        setSchemaRefreshToken((token) => token + 1);
        setEditingConnection(null);
      }}
      importPreview={importPreview}
      onCloseImportPreview={() => setImportPreview(null)}
      onImportedConnections={() => {
        setSchemaRefreshToken((token) => token + 1);
        void refreshConnections();
      }}
    />
    </DbWorkspaceProviders>
    </DbSidebarLinkageProvider>
    <DatabaseTableEditorHost
      rowEdit={rowEdit}
      tableColumnMeta={editorTableColumnMeta ? { [editorHostTabId!]: editorTableColumnMeta } : {}}
      tabDirtyRows={editorHostTabId ? { [editorHostTabId]: editorTabDirtyRows } : {}}
      onRowSave={handleRowSave}
      onRowCancel={() => setRowEdit(null)}
    />
    {isActiveRoute && ctxMenu && (() => {
        const visibleDockTabs = workspaceTabs.filter((tab) => !tab.workspaceOnly);
        const menuTabIndex = visibleDockTabs.findIndex((tab) => tab.id === ctxMenu.tabId);
        const closeItems = buildTabCloseMenuItems(
          t,
          visibleDockTabs.length,
          menuTabIndex >= 0 ? menuTabIndex : 0,
          handleContextAction,
          {
            showWorkspaceActions: true,
            showRename: true,
            currentWorkspaceId: activeWorkspaceId,
            workspaces,
            onMoveToWorkspace: (workspaceId) =>
              performMoveTabToWorkspace(ctxMenu.tabId, workspaceId),
          },
        );
      return (
        <ContextMenu
          items={closeItems}
          position={{ x: ctxMenu.x, y: ctxMenu.y }}
          onClose={() => setCtxMenu(null)}
        />
      );
    })()}
    {isActiveRoute && exportMenu && (
      <ContextMenu
        items={buildExportMenuItems()}
        position={{ x: exportMenu.x, y: exportMenu.y }}
        onClose={() => setExportMenu(null)}
      />
    )}
    <CsvExportDialog
      open={csvExportDialog != null}
      payload={csvExportDialog}
      onClose={() => setCsvExportDialog(null)}
    />
    </>
  );
}
