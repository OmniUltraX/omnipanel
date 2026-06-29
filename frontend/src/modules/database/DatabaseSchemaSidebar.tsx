import { useEffect } from "react";
import {
  usePersistedVerticalSplitSections,
  VerticalSplitSidebar,
} from "../../components/ui/VerticalSplitSidebar";
import { useI18n } from "../../i18n";
import { useDbSidebarLinkage } from "./DbSidebarLinkageContext";
import { SchemaBrowser, type SchemaBrowserProps } from "./SchemaBrowser";
import { SqlQueryFilePanel } from "./SqlQueryFilePanel";
import { SyncTaskListPanel } from "./SyncTaskListPanel";
import type { DbSqlFileNode } from "../../stores/dbSqlFileStore";
import type { SyncTask } from "./toolbox/types";

const SECTION_STORAGE_KEY = "omnipanel-db-schema-sidebar-sections";

type SectionKey = "connections" | "queries" | "syncTasks";

export interface DatabaseSchemaSidebarProps
  extends Omit<SchemaBrowserProps, "activeConnId" | "activeTableKey" | "activeDatabaseKey"> {
  onOpenSqlFile: (file: DbSqlFileNode) => void;
  onOpenSyncTask: (task: SyncTask) => void;
  onRunSyncTask: (task: SyncTask) => void;
}

export function DatabaseSchemaSidebar({
  onOpenSqlFile,
  onOpenSyncTask,
  onRunSyncTask,
  ...schemaProps
}: DatabaseSchemaSidebarProps) {
  const { t } = useI18n();
  const { activeConnId, activeTableKey, activeDatabaseKey } = useDbSidebarLinkage();
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
        activeConnId={activeConnId}
        activeTableKey={activeTableKey}
        activeDatabaseKey={activeDatabaseKey}
        section={{
          title: t("database.sidebar.connections"),
          expanded: sections.connections,
          onToggle: () => toggleSection("connections"),
        }}
      />
      <SqlQueryFilePanel
        onOpenFile={onOpenSqlFile}
        section={{
          title: t("database.sidebar.queries"),
          expanded: sections.queries,
          onToggle: () => toggleSection("queries"),
        }}
      />
      <SyncTaskListPanel
        onOpenTask={onOpenSyncTask}
        onRunTask={onRunSyncTask}
        section={{
          title: t("database.sidebar.syncTasks"),
          expanded: sections.syncTasks,
          onToggle: () => toggleSection("syncTasks"),
        }}
      />
    </VerticalSplitSidebar>
  );
}
