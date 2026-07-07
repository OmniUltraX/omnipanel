import { memo, type MouseEvent, type ReactNode } from "react";
import type { SerializedDockview } from "dockview-core";

import { ModuleWorkspaceLayout } from "../../components/workspace";
import { DbSchemaProvider } from "./schema/DbSchemaContext";
import { DatabaseSchemaSidebar } from "./schema/DatabaseSchemaSidebar";
import { DatabaseWorkspaceDock } from "./workspace/DatabaseWorkspaceDock";
import type { DbSchemaContextValue } from "./schema/DbSchemaContext";
import type { DbConnectionConfig } from "./api";
import type { SchemaTreeItem } from "./schema/schemaTreeItem";
import type {
  SchemaContextMenuContext,
  SchemaDatabaseSelection,
  SchemaTableSelection,
} from "./schema/SchemaBrowser";
import type { SchemaCacheConnectionEntry } from "./schema/schemaCache";
import type { ContextMenuItem } from "../../components/ui/menu/ContextMenu";
import type { DbSqlFileNode } from "../../stores/dbSqlFileStore";
import type { SyncTask } from "./toolbox/types";
import type { DockableTab } from "../../components/dock";

export interface DatabasePanelWorkspaceViewProps {
  moduleTitle: string;
  schemaContextValue: DbSchemaContextValue;
  connections: DbConnectionConfig[];
  connectionsLoading: boolean;
  schemaRefreshToken: number;
  workspaceInitialized: boolean;
  dockTabs: DockableTab[];
  moduleLive: boolean;
  dockLayout: SerializedDockview | null;
  panelContentKeysByTab: Record<string, string>;
  moduleSoftRefreshKey: string;
  emptyPrompt: string;
  recentClosedTitle: string;
  recentClosedActionItems: Array<{ id: string; label: string; meta: string; onClick: () => void }>;
  onCreateConnection: () => void;
  onImportNavicat: () => void;
  onSelectConnection: (connId: string) => void;
  onOpenSqlFile: (file: DbSqlFileNode) => void;
  onOpenSyncTask: (task: SyncTask) => void;
  onRunSyncTask: (task: SyncTask) => void;
  onSelectTable: (selection: SchemaTableSelection) => void;
  onSelectDatabase: (selection: SchemaDatabaseSelection) => void;
  buildSchemaContextMenuItems: (
    item: SchemaTreeItem,
    context: SchemaContextMenuContext,
  ) => ContextMenuItem[];
  onConnectionContextMenu: (connection: DbConnectionConfig) => void;
  onSchemaCacheConnectionPatched: (connId: string, entry: SchemaCacheConnectionEntry) => void;
  onCloseTab: (tabId: string) => void;
  onDockLayoutChange: (layout: SerializedDockview | null) => void;
  renderDockPanel: (tabId: string) => ReactNode;
  onTabContextMenu: (event: MouseEvent, tabId: string, index: number) => void;
  onTabDoubleClick: (tabId: string) => void;
}

export const DatabasePanelWorkspaceView = memo(function DatabasePanelWorkspaceView({
  moduleTitle,
  schemaContextValue,
  connections,
  connectionsLoading,
  schemaRefreshToken,
  workspaceInitialized,
  dockTabs,
  moduleLive,
  dockLayout,
  panelContentKeysByTab,
  moduleSoftRefreshKey,
  emptyPrompt,
  recentClosedTitle,
  recentClosedActionItems,
  onCreateConnection,
  onImportNavicat,
  onSelectConnection,
  onOpenSqlFile,
  onOpenSyncTask,
  onRunSyncTask,
  onSelectTable,
  onSelectDatabase,
  buildSchemaContextMenuItems,
  onConnectionContextMenu,
  onSchemaCacheConnectionPatched,
  onCloseTab,
  onDockLayoutChange,
  renderDockPanel,
  onTabContextMenu,
  onTabDoubleClick,
}: DatabasePanelWorkspaceViewProps) {
  return (
    <ModuleWorkspaceLayout
      layoutKey="database"
      className="db-module-layout"
      leftColumnTitle={moduleTitle}
      leftPreset="schema"
      leftSidebar={
        <DbSchemaProvider value={schemaContextValue}>
          <DatabaseSchemaSidebar
            onCreateConnection={onCreateConnection}
            onImportNavicat={onImportNavicat}
            onSelectConnection={onSelectConnection}
            onOpenSqlFile={onOpenSqlFile}
            onOpenSyncTask={onOpenSyncTask}
            onRunSyncTask={onRunSyncTask}
            onSelectTable={onSelectTable}
            onSelectDatabase={onSelectDatabase}
            buildSchemaContextMenuItems={buildSchemaContextMenuItems}
            onConnectionContextMenu={onConnectionContextMenu}
            onSchemaCacheConnectionPatched={onSchemaCacheConnectionPatched}
            refreshToken={schemaRefreshToken}
            connectionConfigs={connections}
            connectionsReady={!connectionsLoading || connections.length > 0}
          />
        </DbSchemaProvider>
      }
    >
      <div className="db-workspace-drop-zone">
        {!workspaceInitialized ? null : (
          <DatabaseWorkspaceDock
            workspaceInitialized={workspaceInitialized}
            dockTabs={dockTabs}
            moduleTitle={moduleTitle}
            enabled={moduleLive}
            windowControl
            onCloseTab={onCloseTab}
            dockLayout={dockLayout}
            onDockLayoutChange={onDockLayoutChange}
            renderDockPanel={renderDockPanel}
            softRefreshKey={moduleSoftRefreshKey}
            panelContentKeysByTab={panelContentKeysByTab}
            onTabContextMenu={onTabContextMenu}
            onTabDoubleClick={onTabDoubleClick}
            recentClosedActionItems={recentClosedActionItems}
            emptyPrompt={emptyPrompt}
            recentClosedTitle={recentClosedTitle}
          />
        )}
      </div>
    </ModuleWorkspaceLayout>
  );
});
