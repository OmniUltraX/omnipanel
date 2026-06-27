import { useCallback, useMemo } from "react";
import { useLocation } from "react-router-dom";
import { useI18n } from "../../i18n";
import { ModuleSegmentDock } from "../../components/dock";
import { usePersistedModuleTab } from "../../hooks/usePersistedModuleTab";
import { KnowledgeLibraryView } from "./KnowledgeLibraryView";
import { KnowledgeTodosView } from "./KnowledgeTodosView";

type KnowledgeModuleTab = "library" | "todos";
const KNOWLEDGE_TABS: KnowledgeModuleTab[] = ["library", "todos"];

export function KnowledgePanel() {
  const { t } = useI18n();
  const location = useLocation();
  const isActiveRoute = location.pathname === "/module/knowledge";
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
      moduleTitle={t("routes.knowledge")}
      tabs={segmentTabs}
      activeTabId={tab}
      onActiveTabChange={(id) => setTab(id as KnowledgeModuleTab)}
      enabled={isActiveRoute}
      renderPanel={renderPanel}
    />
  );
}
