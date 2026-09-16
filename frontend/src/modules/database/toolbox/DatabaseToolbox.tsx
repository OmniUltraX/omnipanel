import { Button } from "../../../components/ui/Button";
import { IconSettings, IconClock, IconFile, IconTrash } from "../../../components/ui/Icons";
import { SubWindow } from "../../../components/ui/SubWindow";
import { ModuleEmptyState } from "../../../components/ui/ModuleEmptyState";
import { SyncSidePanel } from "./SyncSidePanel";
import { SyncTaskSettingsDialog } from "./SyncTaskSettingsDialog";
import { SyncTaskHistoryPanel } from "./SyncTaskHistoryPanel";
import { SyncTaskScriptPreviewPanel } from "./SyncTaskScriptPreviewPanel";
import { SyncTaskExecuteConfirmDialog } from "./SyncTaskExecuteConfirmDialog";
import { DbToolboxSplitLayout } from "./DbToolboxSplitLayout";
import { TableRowDiffPanel } from "./TableRowDiffPanel";
import { useDatabaseToolboxModel } from "./useDatabaseToolboxModel";
import type { DatabaseToolboxProps } from "./databaseToolboxTypes";

export type { DatabaseToolboxProps } from "./databaseToolboxTypes";

export function DatabaseToolbox(props: DatabaseToolboxProps) {
  const {
    t,
    loadTotal,
    loadCurrent,
    loadMessage,
    connections,
    tab,
    syncTaskId,
    sourceConnId,
    sourceDb,
    setSourceDb,
    targetConnId,
    targetDb,
    setTargetDb,
    sourceDbs,
    targetDbs,
    sourceDbsLoading,
    targetDbsLoading,
    sourceSnapshot,
    sourceCatalogNames,
    sourceCatalogLoading,
    sourceCatalogError,
    sourceAddingTables,
    targetSnapshot,
    targetTablesLoading,
    sourceExpanded,
    schemaCaseSensitive,
    schemaCreateMissingTables,
    schemaTargetStatusFilters,
    setSchemaTargetStatusFilters,
    schemaTableSearch,
    setSchemaTableSearch,
    ignoredFields,
    sourceListRef,
    targetListRef,
    sourceSelected,
    sourceListHighlight,
    setSourceListHighlight,
    tableTargetStatus,
    tableSyncModes,
    tableAnalysis,
    conflictDetailTable,
    setConflictDetailTable,
    submitting,
    syncLockedTables,
    submitNotice,
    taskSettingsOpen,
    setTaskSettingsOpen,
    taskHistoryOpen,
    setTaskHistoryOpen,
    taskScriptPreviewOpen,
    setTaskScriptPreviewOpen,
    executeConfirmSnapshot,
    taskName,
    targetConfigured,
    resolvedSchemaTableNameCase,
    countingTables,
    schemaDiffsForView,
    visibleSchemaAlignedTableNames,
    sourceSelectedTableNames,
    sourceTableColumns,
    sourceTableIndexes,
    sourceTableNameSet,
    toggleSourceTable,
    toggleSourceSelected,
    handleSourceSelectAll,
    syncSourceTableSelection,
    removeSourceTables,
    setTableSyncMode,
    canSubmitTable,
    handleSingleTableSubmit,
    handleViewConflictDetail,
    handleAnalyze,
    analyzeBusy,
    hasAnalysisResult,
    handleAnalyzeTable,
    dataSyncAnalyzingTables,
    scriptPreviewInput,
    executeConfirmTitle,
    closeExecuteConfirmDialog,
    handleExecuteConfirm,
    handleApplyTaskSettings,
    resolveTaskName,
    canSubmit,
    submitDisabledReason,
    canAnalyzeAll,
    analyzeAllDisabledReason,
    syncAnalysisBusy,
    hasDataAnalysisResult,
    handleDataAnalyze,
    handleSubmit,
    handleSourceConnectionChange,
    handleTargetConnectionChange,
    dataSyncProgressLabel,
    lastAnalysisTimeLabel,
    conflictDetailIgnoredColumns,
    EMPTY_SNAPSHOT,
  } = useDatabaseToolboxModel(props);

if (connections.length === 0) {
  return (
    <div className="db-toolbox">
      <ModuleEmptyState
        preset="inbox"
        title={t("database.toolbox.empty.noCapableConnection.title")}
        desc={t("database.toolbox.empty.noCapableConnection.desc")}
      />
    </div>
  );
}

return (
  <div className="db-toolbox">
    <div className="db-toolbox-panels" role="tabpanel">
      <DbToolboxSplitLayout
        source={
          <SyncSidePanel
            sideLabel={t("database.toolbox.side.source")}
            connections={connections}
            connectionId={sourceConnId}
            database={sourceDb}
            onConnectionChange={handleSourceConnectionChange}
            onDatabaseChange={setSourceDb}
            databases={sourceDbs}
            databasesLoading={sourceDbsLoading}
            snapshot={sourceSnapshot}
            catalogLoading={tab === "schemaSync" ? sourceSnapshot.loading : sourceCatalogLoading}
            catalogError={sourceCatalogError}
            catalogTableNames={sourceCatalogNames}
            loadingProgress={
              sourceCatalogLoading || sourceSnapshot.loading
                ? { total: loadTotal, current: loadCurrent, message: loadMessage }
                : undefined
            }
            tab={tab}
            expandedTables={sourceExpanded}
            onToggleTable={toggleSourceTable}
            selectedTables={sourceSelected}
            onToggleSelect={toggleSourceSelected}
            onSelectAllChange={tab === "schemaSync" ? handleSourceSelectAll : undefined}
            onSelectedTablesChange={
              tab === "dataSync" ? syncSourceTableSelection : undefined
            }
            onRemoveTables={tab === "dataSync" ? removeSourceTables : undefined}
            listHighlight={tab === "dataSync" ? sourceListHighlight : undefined}
            onListHighlightChange={tab === "dataSync" ? setSourceListHighlight : undefined}
            addingTables={sourceAddingTables}
            countingTables={countingTables}
            alignedTableNames={visibleSchemaAlignedTableNames}
            schemaTableSearch={schemaTableSearch}
            onSchemaTableSearchChange={setSchemaTableSearch}
            schemaStatusFilters={tab === "schemaSync" ? schemaTargetStatusFilters : undefined}
            schemaCaseSensitive={schemaCaseSensitive}
            scrollListRef={sourceListRef}
          />
        }
        target={
          <SyncSidePanel
            sideLabel={t("database.toolbox.side.target")}
            tableListMode="targetSync"
            connections={connections}
            connectionId={targetConnId}
            database={targetDb}
            onConnectionChange={handleTargetConnectionChange}
            onDatabaseChange={setTargetDb}
            databases={targetDbs}
            databasesLoading={targetDbsLoading}
            snapshot={tab === "schemaSync" ? targetSnapshot : EMPTY_SNAPSHOT}
            tab={tab}
            expandedTables={sourceExpanded}
            onToggleTable={toggleSourceTable}
            selectedTables={tab === "schemaSync" ? sourceSelected : new Set()}
            onToggleSelect={() => {}}
            sourceSelectedTableNames={sourceSelectedTableNames}
            targetConfigured={targetConfigured}
            targetTablesLoading={tab === "schemaSync" ? targetSnapshot.loading : targetTablesLoading}
            tableTargetStatus={tableTargetStatus}
            tableSyncModes={tableSyncModes}
            onSyncModeChange={setTableSyncMode}
            syncLockedTables={syncLockedTables}
            canSubmitTable={canSubmitTable}
            onSyncTableSubmit={(tableName) => void handleSingleTableSubmit(tableName)}
            schemaTableDiffs={schemaDiffsForView}
            tableAnalysis={tableAnalysis}
            conflictDetailTable={conflictDetailTable}
            onViewConflictDetail={handleViewConflictDetail}
            schemaStatusFilters={schemaTargetStatusFilters}
            onSchemaStatusFiltersChange={setSchemaTargetStatusFilters}
            sourceTableColumns={sourceTableColumns}
            sourceTableIndexes={sourceTableIndexes}
            alignedTableNames={visibleSchemaAlignedTableNames}
            targetSnapshot={targetSnapshot}
            sourceTableNames={sourceTableNameSet}
            schemaCaseSensitive={schemaCaseSensitive}
            scrollListRef={targetListRef}
            onAnalyze={
              tab === "schemaSync" && targetConfigured ? handleAnalyze : undefined
            }
            analyzeBusy={tab === "schemaSync" ? analyzeBusy : undefined}
            hasAnalysisResult={tab === "schemaSync" ? hasAnalysisResult : undefined}
            onAnalyzeTable={
              tab === "dataSync" && targetConfigured ? handleAnalyzeTable : undefined
            }
            analyzingTables={tab === "dataSync" ? dataSyncAnalyzingTables : undefined}
          />
        }
      />
    </div>

    <footer className="db-toolbox-footer">
      <div className="db-toolbox-footer__start">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          title={t("database.toolbox.settingsTitle")}
          aria-label={t("database.toolbox.settingsTitle")}
          onClick={() => setTaskSettingsOpen(true)}
        >
          <IconSettings size={18} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          title={t("database.toolbox.scriptPreviewTitle")}
          aria-label={t("database.toolbox.scriptPreviewTitle")}
          disabled={!scriptPreviewInput}
          onClick={() => setTaskScriptPreviewOpen(true)}
        >
          <IconFile size={18} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          title={t("database.toolbox.historyTitle")}
          aria-label={t("database.toolbox.historyTitle")}
          onClick={() => setTaskHistoryOpen(true)}
        >
          <IconClock size={18} />
        </Button>
        {tab === "dataSync" ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="db-toolbox-footer__remove-selected"
            disabled={sourceListHighlight.size === 0}
            title={
              sourceListHighlight.size === 0
                ? t("database.toolbox.side.removeSelectedDisabled")
                : t("database.toolbox.side.removeSelected", { count: sourceListHighlight.size })
            }
            aria-label={
              sourceListHighlight.size === 0
                ? t("database.toolbox.side.removeSelectedDisabled")
                : t("database.toolbox.side.removeSelected", { count: sourceListHighlight.size })
            }
            onClick={() => removeSourceTables(Array.from(sourceListHighlight))}
          >
            <IconTrash size={18} />
          </Button>
        ) : null}
      </div>
      <div className="db-toolbox-footer__meta">
        {submitNotice ? (
          <span className="db-toolbox-footer__notice">{submitNotice}</span>
        ) : dataSyncProgressLabel ? (
          <span className="db-toolbox-footer__hint db-toolbox-footer__hint--progress">
            {dataSyncProgressLabel}
          </span>
        ) : submitDisabledReason && !canSubmit ? (
          <span className="db-toolbox-footer__hint">{submitDisabledReason}</span>
        ) : hasAnalysisResult && lastAnalysisTimeLabel ? (
          <span className="db-toolbox-footer__hint">
            {t("database.toolbox.side.analyzedAt", { time: lastAnalysisTimeLabel })}
          </span>
        ) : (
          <span className="db-toolbox-footer__hint">
            {tab === "dataSync"
              ? t("database.toolbox.submitHintData", { count: sourceSelected.size })
              : t("database.toolbox.submitHintSchema", { count: sourceSelected.size })}
          </span>
        )}
      </div>
      <div className="db-toolbox-footer__actions">
        {tab === "dataSync" && targetConfigured && (
          <Button
            type="button"
            variant="ghost"
            disabled={!canAnalyzeAll}
            title={
              analyzeAllDisabledReason ??
              (hasDataAnalysisResult
                ? t("database.toolbox.reanalyzeAllHint")
                : t("database.toolbox.analyzeAllHint"))
            }
            onClick={() => void handleDataAnalyze()}
          >
            {syncAnalysisBusy
              ? t("database.toolbox.side.analysisAnalyzing")
              : hasDataAnalysisResult
                ? t("database.toolbox.reanalyzeAll")
                : t("database.toolbox.analyzeAll")}
          </Button>
        )}
        <Button
          type="button"
          variant="default"
          disabled={!canSubmit || submitting}
          onClick={() => void handleSubmit()}
        >
          {t("database.toolbox.submit")}
        </Button>
      </div>
    </footer>

    <SyncTaskSettingsDialog
      open={taskSettingsOpen}
      onClose={() => setTaskSettingsOpen(false)}
      tab={tab}
      taskName={taskName}
      schemaCaseSensitive={schemaCaseSensitive}
      schemaTableNameCase={resolvedSchemaTableNameCase}
      schemaCreateMissingTables={schemaCreateMissingTables}
      ignoredFields={ignoredFields}
      onApply={handleApplyTaskSettings}
    />

    <SubWindow
      open={taskHistoryOpen}
      title={t("database.toolbox.taskHistoryTitleNamed", {
        name: taskName.trim() || resolveTaskName(),
      })}
      onClose={() => setTaskHistoryOpen(false)}
      className="db-toolbox-history-subwindow"
      widthRatio={0.62}
      heightRatio={0.68}
    >
      <SyncTaskHistoryPanel
        taskId={syncTaskId}
        taskName={taskName.trim() || resolveTaskName()}
      />
    </SubWindow>

    <SubWindow
      open={taskScriptPreviewOpen}
      title={t("database.toolbox.scriptPreviewTitleNamed", {
        name: taskName.trim() || resolveTaskName(),
      })}
      onClose={() => setTaskScriptPreviewOpen(false)}
      className="db-toolbox-script-preview-subwindow"
      widthRatio={0.72}
      heightRatio={0.72}
    >
      <SyncTaskScriptPreviewPanel input={taskScriptPreviewOpen ? scriptPreviewInput : null} />
    </SubWindow>

    <SyncTaskExecuteConfirmDialog
      open={executeConfirmSnapshot !== null}
      title={executeConfirmTitle}
      input={executeConfirmSnapshot}
      confirming={submitting}
      onClose={closeExecuteConfirmDialog}
      onConfirm={handleExecuteConfirm}
    />

    <SubWindow
      open={conflictDetailTable !== null}
      title={
        conflictDetailTable
          ? t("database.toolbox.side.rowDiffTitle", { table: conflictDetailTable })
          : t("database.toolbox.side.rowDiffTitleFallback")
      }
      onClose={() => setConflictDetailTable(null)}
      className="db-toolbox-conflict-subwindow"
      widthRatio={0.82}
      heightRatio={0.72}
    >
      {conflictDetailTable ? (
        <TableRowDiffPanel
          tableName={conflictDetailTable}
          analysis={tableAnalysis[conflictDetailTable]}
          columns={sourceTableColumns[conflictDetailTable] ?? []}
          ignoredColumns={conflictDetailIgnoredColumns}
        />
      ) : null}
    </SubWindow>
  </div>
);

}
