import { useCallback, useEffect, useMemo } from "react";
import { useLocation } from "react-router-dom";
import { useI18n } from "../../i18n";
import { SidebarWorkspace } from "../../components/ui/SidebarWorkspace";
import { ModuleSegmentDock } from "../../components/dock";
import { usePersistedModuleTab } from "../../hooks/usePersistedModuleTab";
import { useKnowledgeStore } from "../../stores/knowledgeStore";
import { KnowledgeSidebar } from "./KnowledgeSidebar";
import { KnowledgeMarkdownWorkspace } from "./KnowledgeMarkdownWorkspace";
import { KnowledgeTodosView } from "./KnowledgeTodosView";

type KnowledgeModuleTab = "library" | "todos";
const KNOWLEDGE_TABS: KnowledgeModuleTab[] = ["library", "todos"];

function KnowledgeLibraryView() {
  const loadEntries = useKnowledgeStore((s) => s.loadEntries);
  const error = useKnowledgeStore((s) => s.error);
  const clearError = useKnowledgeStore((s) => s.clearError);

  useEffect(() => {
    void loadEntries();
  }, [loadEntries]);

  return (
    <div className="knowledge-panel">
      {error && (
        <div className="knowledge-error knowledge-error--floating">
          <span>{error}</span>
          <button type="button" onClick={clearError}>×</button>
        </div>
      )}
      <SidebarWorkspace
        preset="schema"
        sidebarMinPx={240}
        sidebarMaxPx={420}
        sidebar={<KnowledgeSidebar />}
      >
        <KnowledgeMarkdownWorkspace />
      </SidebarWorkspace>
    </div>
  );
}

export function KnowledgePanel() {
  const { t } = useI18n();
  const location = useLocation();
  const isActiveRoute = location.pathname === "/knowledge";
  const [tab, setTab] = usePersistedModuleTab("knowledge", "library", KNOWLEDGE_TABS);

  const segmentTabs = useMemo(
    () => [
      { id: "library", label: t("knowledge.tabs.library") },
      { id: "todos", label: t("knowledge.tabs.todos") },
    ],
    [t],
  );

  const renderPanel = useCallback((tabId: string) => {
    if (tabId === "library") {
      return <KnowledgeLibraryView />;
    }
    if (tabId === "todos") {
      return <KnowledgeTodosView />;
    }
    return null;
  }, []);

  return (
    <ModuleSegmentDock
      className="knowledge-module-dock"
      tabs={segmentTabs}
      activeTabId={tab}
      onActiveTabChange={(id) => setTab(id as KnowledgeModuleTab)}
      enabled={isActiveRoute}
      renderPanel={renderPanel}
    />
  );
}
