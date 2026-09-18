import { WorkbenchActionButton } from "../../../components/ui/primitives/WorkbenchActionButton";
import { ModuleSidebarTreeToolbar } from "@/components/ui/module-sidebar";
import { IconDropdownButton } from "../../../components/ui/menu";
import { ScopedSearch } from "../../../components/ui/search";
import { ContextMenu } from "../../../components/ui/menu";
import { appAlert } from "../../../lib/appAlert";
import {
  makeTableFilterKey,
  mergeFilter,
  applyTablePinOrder,
  SchemaFilterDialog,
} from "./DatabaseFilterDialog";
import { estimateSchemaFlatRowSize } from "./schemaTreeFlatRows";
import { ModuleSidebarSection } from "@/components/ui/module-sidebar";
import {
  SidebarTreeSelectionProvider,
} from "@/components/ui/sidebar-tree";
import { SchemaTreeHotkeys } from "./SchemaTreeHotkeys";
import { SchemaTreeSelectionSync } from "./SchemaTreeSelectionSync";
import { useSchemaBrowserModel } from "./useSchemaBrowserModel";
import type { SchemaBrowserProps } from "./schemaBrowserTypes";

export type {
  SchemaTableSelection,
  SchemaDatabaseSelection,
  SchemaContextMenuContext,
  SchemaBrowserProps,
} from "./schemaBrowserTypes";

export { makeDatabaseNodeId } from "./schemaTreeIds";

export function SchemaBrowser({
  activeConnId = null,
  onCreateConnection,
  onNewSqlQuery,
  onImportNavicat,
  onSelectConnection,
  onSelectTable,
  onSelectDatabase,
  onOpenSqlFile,
  buildSchemaContextMenuItems,
  onDeleteConnections,
  onSchemaCacheConnectionPatched,
  activeTableKey = null,
  activeDatabaseKey = null,
  openTabNodeIds,
  refreshToken = 0,
  section,
  connectionConfigs,
  connectionsReady,
}: SchemaBrowserProps) {
  const {
    t,
    search,
    setSearch,
    expandedNodeIds,
    anyConnectionRefreshing,
    sidebarRef,
    schemaTreeRef,
    scopedSearchRef,
    pathCrumbs,
    loading,
    loadError,
    hasAnyConnection,
    databaseFilters,
    tableFilters,
    setDatabaseFilters,
    setTableFilters,
    filterDialogConnId,
    setFilterDialogConnId,
    filterDialogTable,
    setFilterDialogTable,
    schemaCtxMenu,
    setSchemaCtxMenu,
    selectableNodeIds,
    handleSelectedIdsChange,
    sidebarHotkeysArmedRef,
    handleHotkeyDelete,
    sidebarScrollTargetId,
    useTreeVirtualization,
    flatRows,
    virtualRows,
    rowVirtualizer,
    renderFlatRow,
    handleTreeKeyDown,
    handleContextLayoutRoot,
    handlePathCrumbClick,
    handleCollapseAll,
    refreshSchemaCache,
    getSchemaTreeContextMenuItems,
    filterDialogConn,
    filterDialogTableDb,
  } = useSchemaBrowserModel({
    activeConnId,
    onSelectConnection,
    onSelectTable,
    onSelectDatabase,
    onOpenSqlFile,
    buildSchemaContextMenuItems,
    onDeleteConnections,
    onSchemaCacheConnectionPatched,
    activeTableKey,
    activeDatabaseKey,
    openTabNodeIds,
    refreshToken,
    connectionConfigs,
    connectionsReady,
  });

  const toolbar = (
    <div className="schema-toolbar schema-toolbar--inline">
      <WorkbenchActionButton
        icon
        title={t("database.sidebar.createConnection")}
        aria-label={t("database.sidebar.createConnection")}
        onClick={onCreateConnection}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </WorkbenchActionButton>
      {onNewSqlQuery ? (
        <WorkbenchActionButton
          icon
          title={t("database.workspace.newQuery")}
          aria-label={t("database.workspace.newQuery")}
          onClick={onNewSqlQuery}
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" width="12" height="12" aria-hidden>
            <path d="M3 4.5h10M3 8h10M3 11.5h6" strokeLinecap="round" />
            <path d="M11.5 8.5 13 10l-2 2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </WorkbenchActionButton>
      ) : null}
      {onImportNavicat ? (
        <IconDropdownButton
          title={t("database.sidebar.importConnections")}
          size="icon-xs"
          icon={
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
              <path d="M12 3v12" />
              <path d="M8 11l4 4 4-4" />
              <path d="M4 21h16" />
            </svg>
          }
          items={[
            {
              id: "datagrip",
              label: t("database.sidebar.importFormatDatagrip"),
              subtitle: t("database.connectionImport.inDevelopment"),
              onSelect: () => {
                void appAlert(
                  t("database.connectionImport.inDevelopment"),
                  t("database.sidebar.importFormatDatagrip"),
                );
              },
            },
            {
              id: "navicat",
              label: t("database.sidebar.importFormatNavicat"),
              onSelect: onImportNavicat,
            },
            {
              id: "dbeaver",
              label: t("database.sidebar.importFormatDbeaver"),
              subtitle: t("database.connectionImport.inDevelopment"),
              onSelect: () => {
                void appAlert(
                  t("database.connectionImport.inDevelopment"),
                  t("database.sidebar.importFormatDbeaver"),
                );
              },
            },
          ]}
        />
      ) : null}
      <ModuleSidebarTreeToolbar
        onRefresh={() => void refreshSchemaCache()}
        onCollapseAll={handleCollapseAll}
        refreshing={anyConnectionRefreshing}
        refreshDisabled={anyConnectionRefreshing}
        collapseDisabled={expandedNodeIds.size === 0}
      />
    </div>
  );

  const panelBody = (
    <div className="schema-browser" ref={sidebarRef}>
      {!section && toolbar}
      <ScopedSearch
        ref={scopedSearchRef}
        className="schema-tree-scoped-search"
        value={search}
        onChange={setSearch}
        placeholder={t("database.sidebar.search")}
        enabled={filterDialogConnId === null && filterDialogTable === null}
      >
        <div className="schema-tree-stack">
          <nav
            className={`schema-tree-path${pathCrumbs.length === 0 ? " schema-tree-path--empty" : ""}`}
            aria-label={t("database.sidebar.scrollPath")}
          >
            {pathCrumbs.length > 0 ? (
              pathCrumbs.map((crumb, index) => (
                <span key={crumb.row.key} className="schema-tree-path__item">
                  {index > 0 ? (
                    <span className="schema-tree-path__sep" aria-hidden>
                      /
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className={`schema-tree-path__crumb${
                      index === pathCrumbs.length - 1 ? " schema-tree-path__crumb--current" : ""
                    }`}
                    title={crumb.row.item.label}
                    onClick={() => handlePathCrumbClick(crumb.rowIndex)}
                  >
                    {crumb.row.item.label}
                  </button>
                </span>
              ))
            ) : (
              <span className="schema-tree-path__placeholder" aria-hidden>
                &nbsp;
              </span>
            )}
          </nav>
          <div
            className={`schema-tree${useTreeVirtualization ? " schema-tree--virtual" : ""}`}
            ref={schemaTreeRef}
            tabIndex={-1}
            onKeyDown={handleTreeKeyDown}
            onContextMenu={handleContextLayoutRoot}
          >
        <SidebarTreeSelectionProvider
          orderedKeys={selectableNodeIds}
          onSelectedIdsChange={handleSelectedIdsChange}
        >
        <SchemaTreeHotkeys
          allKeys={selectableNodeIds}
          armedRef={sidebarHotkeysArmedRef}
          onDeleteSelected={handleHotkeyDelete}
        />
        <SchemaTreeSelectionSync targetId={sidebarScrollTargetId} />
        {loading && (
          <div style={{ padding: "12px 16px", fontSize: "12px", color: "var(--text-secondary, #8e8e93)" }}>
            {t("common.loading")}
          </div>
        )}
        {!loading && loadError && (
          <div style={{ padding: "12px 16px", fontSize: "12px", color: "var(--color-danger, #ff3b30)" }}>
            {t("database.sidebar.loadFailed")}: {loadError}
          </div>
        )}
        {!loading && !loadError && !hasAnyConnection && (
          <div style={{ padding: "12px 16px", fontSize: "12px", color: "var(--text-secondary, #8e8e93)" }}>
            {t("database.sidebar.empty")}
          </div>
        )}
        {!loading && !loadError && hasAnyConnection && useTreeVirtualization && (
          <div
            className="schema-tree-virtual-inner"
            style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}
          >
            {virtualRows.map((virtualRow) => {
              const row = flatRows[virtualRow.index];
              if (!row) return null;
              return (
                <div
                  key={virtualRow.key}
                  data-index={virtualRow.index}
                  className="schema-tree-virtual-row schema-tree-virtual-row--absolute"
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: virtualRow.size,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  {renderFlatRow(row)}
                </div>
              );
            })}
          </div>
        )}
        {!loading && !loadError && hasAnyConnection && !useTreeVirtualization && (
          <div className="schema-tree-native-inner">
            {flatRows.map((row) => (
              <div
                key={row.key}
                className="schema-tree-native-row"
                style={{ height: estimateSchemaFlatRowSize(row) }}
              >
                {renderFlatRow(row)}
              </div>
            ))}
          </div>
        )}
        </SidebarTreeSelectionProvider>
      </div>
        </div>
      </ScopedSearch>

      {filterDialogConn && filterDialogConn.databases && (
        <SchemaFilterDialog
          open={filterDialogConnId !== null}
          title={t("database.filter.title", { name: filterDialogConn.config.name })}
          items={filterDialogConn.databases.map((db) => db.name)}
          initial={
            databaseFilters[filterDialogConn.config.id] ??
            mergeFilter(undefined, filterDialogConn.databases.map((db) => db.name))
          }
          onClose={() => setFilterDialogConnId(null)}
          onApply={(state) => {
            setDatabaseFilters((prev) => ({
              ...prev,
              [filterDialogConn.config.id]: state,
            }));
          }}
        />
      )}

      {filterDialogTable && filterDialogTableDb?.tables && (
        <SchemaFilterDialog
          open={filterDialogTable !== null}
          title={t("database.filter.tableTitle", { name: filterDialogTable.dbName })}
          items={filterDialogTableDb.tables.map((tbl) => tbl.name)}
          initial={
            tableFilters[makeTableFilterKey(filterDialogTable.connId, filterDialogTable.dbName)] ??
            mergeFilter(undefined, filterDialogTableDb.tables.map((tbl) => tbl.name))
          }
          onClose={() => setFilterDialogTable(null)}
          onApply={(state) => {
            const key = makeTableFilterKey(filterDialogTable.connId, filterDialogTable.dbName);
            const items = (filterDialogTableDb.tables ?? []).map((tbl) => tbl.name);
            setTableFilters((prev) => {
              const pinnedNames = (prev[key]?.pinnedNames ?? []).filter((name) =>
                state.visibleNames.has(name),
              );
              return {
                ...prev,
                [key]: {
                  ...state,
                  pinnedNames,
                  orderedNames: applyTablePinOrder(state.orderedNames, pinnedNames, items),
                },
              };
            });
          }}
        />
      )}
      {schemaCtxMenu && (
        <ContextMenu
          items={getSchemaTreeContextMenuItems()}
          position={{ x: schemaCtxMenu.x, y: schemaCtxMenu.y }}
          onClose={() => setSchemaCtxMenu(null)}
        />
      )}
    </div>
  );

  if (section) {
    return (
      <ModuleSidebarSection {...section} count={connectionConfigs?.length ?? 0} actions={toolbar}>
        {panelBody}
      </ModuleSidebarSection>
    );
  }

  return panelBody;
}
