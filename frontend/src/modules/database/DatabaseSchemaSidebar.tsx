import { useEffect } from "react";
import {
  usePersistedVerticalSplitSections,
  VerticalSplitSidebar,
} from "../../components/ui/VerticalSplitSidebar";
import { useI18n } from "../../i18n";
import { useDbSidebarLinkage } from "./DbSidebarLinkageContext";
import { SchemaBrowser, type SchemaBrowserProps } from "./SchemaBrowser";
import { SqlQueryFilePanel } from "./SqlQueryFilePanel";
import type { DbSqlFileNode } from "../../stores/dbSqlFileStore";

const SECTION_STORAGE_KEY = "omnipanel-db-schema-sidebar-sections";

type SectionKey = "connections" | "queries";

export interface DatabaseSchemaSidebarProps
  extends Omit<SchemaBrowserProps, "activeConnId" | "activeTableKey" | "activeDatabaseKey"> {
  onOpenSqlFile: (file: DbSqlFileNode) => void;
}

export function DatabaseSchemaSidebar({
  onOpenSqlFile,
  ...schemaProps
}: DatabaseSchemaSidebarProps) {
  const { t } = useI18n();
  const { activeConnId, activeTableKey, activeDatabaseKey } = useDbSidebarLinkage();
  const { sections, toggleSection, setSectionExpanded } = usePersistedVerticalSplitSections<SectionKey>(
    SECTION_STORAGE_KEY,
    { connections: true, queries: true },
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
    </VerticalSplitSidebar>
  );
}
