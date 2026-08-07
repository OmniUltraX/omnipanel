import { memo, useEffect } from "react";

import {
  usePersistedVerticalSplitSections,
  VerticalSplitSidebar,
} from "../../../components/ui/sidebar/VerticalSplitSidebar";

import { useI18n } from "../../../i18n";

import { useDbSidebarLinkage } from "./DbSidebarLinkageContext";

import { SchemaBrowser, type SchemaBrowserProps } from "./SchemaBrowser";

import { SqlQueryFilePanel } from "../sql/SqlQueryFilePanel";

import { SyncTaskListPanel } from "../sync/SyncTaskListPanel";

import type { DbSqlFileNode } from "../../../stores/dbSqlFileStore";

import type { DbTreeChartFileNode } from "../../../stores/dbTreeChartFileStore";

import type { SyncTask } from "../toolbox/types";

const SECTION_STORAGE_KEY = "omnipanel-db-schema-sidebar-sections";
const SIZE_STORAGE_KEY = "omnipanel-db-schema-sidebar-sizes";

type SectionKey = "connections" | "queries" | "syncTasks";

export interface DatabaseSchemaSidebarProps
  extends Omit<SchemaBrowserProps, "activeConnId" | "activeTableKey" | "activeDatabaseKey" | "openTabNodeIds"> {
  onOpenSqlFile: (file: DbSqlFileNode) => void;
  onNewTreeChart?: () => void;
  onOpenTreeChartFile?: (file: DbTreeChartFileNode) => void;
  activeTreeChartFileId?: string | null;
  onOpenSyncTask: (task: SyncTask) => void;
  onRunSyncTask: (task: SyncTask) => void;
  sqlQueryBindingContext?: { connId: string; database: string } | null;
}

/** memo：Dock tabs/layout 变化时父组件重渲，侧栏 props 不变则跳过树 reconcile */
export const DatabaseSchemaSidebar = memo(function DatabaseSchemaSidebar({
  onOpenSqlFile,
  onNewTreeChart,
  onOpenTreeChartFile,
  activeTreeChartFileId,
  onOpenSyncTask,
  onRunSyncTask,
  sqlQueryBindingContext,
  ...schemaProps
}: DatabaseSchemaSidebarProps) {
  const { t } = useI18n();

  const { activeConnId, activeTableKey, activeDatabaseKey, openTabNodeIds } = useDbSidebarLinkage();

  const { sections, toggleSection, setSectionExpanded } = usePersistedVerticalSplitSections<SectionKey>(
    SECTION_STORAGE_KEY,
    { connections: true, queries: true, syncTasks: true },
  );

  useEffect(() => {
    if (!activeTableKey && !activeDatabaseKey && !activeConnId) {
      return;
    }
    setSectionExpanded("connections", true);
  }, [activeTableKey, activeDatabaseKey, activeConnId, setSectionExpanded]);

  return (
    <VerticalSplitSidebar className="schema-sidebar">
      <SchemaBrowser
        {...schemaProps}
        onOpenSqlFile={onOpenSqlFile}
        activeConnId={activeConnId}
        activeTableKey={activeTableKey}
        activeDatabaseKey={activeDatabaseKey}
        openTabNodeIds={openTabNodeIds}
        section={{
          title: t("database.sidebar.connections"),
          expanded: sections.connections,
          onToggle: () => toggleSection("connections"),
        }}
      />
      <SqlQueryFilePanel
        onOpenFile={onOpenSqlFile}
        onNewTreeChart={onNewTreeChart}
        onOpenTreeChartFile={onOpenTreeChartFile}
        activeTreeChartFileId={activeTreeChartFileId}
        connections={schemaProps.connectionConfigs ?? []}
        sqlQueryBindingContext={sqlQueryBindingContext}
        section={{
          title: t("database.sidebar.queries"),
          expanded: sections.queries,
          onToggle: () => toggleSection("queries"),
          autoSize: true,
          autoSizePersist: { storageKey: SIZE_STORAGE_KEY, id: "queries" },
        }}
      />
      <SyncTaskListPanel
        onOpenTask={onOpenSyncTask}
        onRunTask={onRunSyncTask}
        section={{
          title: t("database.sidebar.syncTasks"),
          expanded: sections.syncTasks,
          onToggle: () => toggleSection("syncTasks"),
          autoSize: true,
          autoSizePersist: { storageKey: SIZE_STORAGE_KEY, id: "syncTasks" },
        }}
      />
    </VerticalSplitSidebar>
  );
});
