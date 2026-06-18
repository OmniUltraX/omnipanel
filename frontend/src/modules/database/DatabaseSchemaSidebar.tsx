import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import { SchemaBrowser, type SchemaBrowserProps } from "./SchemaBrowser";
import { SqlQueryFilePanel } from "./SqlQueryFilePanel";
import type { DbSqlFileNode } from "../../stores/dbSqlFileStore";

const SECTION_STORAGE_KEY = "omnipanel-db-schema-sidebar-sections";

type SectionKey = "connections" | "queries";

function readSectionState(): Record<SectionKey, boolean> {
  try {
    const raw = localStorage.getItem(SECTION_STORAGE_KEY);
    if (!raw) {
      return { connections: true, queries: true };
    }
    const parsed = JSON.parse(raw) as Partial<Record<SectionKey, boolean>>;
    return {
      connections: parsed.connections ?? true,
      queries: parsed.queries ?? true,
    };
  } catch {
    return { connections: true, queries: true };
  }
}

export interface DatabaseSchemaSidebarProps extends SchemaBrowserProps {
  onOpenSqlFile: (file: DbSqlFileNode) => void;
}

export function DatabaseSchemaSidebar({
  onOpenSqlFile,
  ...schemaProps
}: DatabaseSchemaSidebarProps) {
  const { t } = useI18n();
  const [sections, setSections] = useState(readSectionState);

  useEffect(() => {
    localStorage.setItem(SECTION_STORAGE_KEY, JSON.stringify(sections));
  }, [sections]);

  const toggleSection = useCallback((key: SectionKey) => {
    setSections((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  return (
    <div className="schema-sidebar">
      <SchemaBrowser
        {...schemaProps}
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
    </div>
  );
}
