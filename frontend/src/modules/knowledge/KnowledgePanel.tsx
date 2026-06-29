import { useCallback, useEffect, useMemo, useRef } from "react";
import { useLocation } from "react-router-dom";
import { collectPanelIds } from "../../components/dock/dockViewLayout";
import { ModuleSegmentDock } from "../../components/dock";
import { ModuleModeIconRail, ModuleWorkspaceLayout } from "../../components/workspace";
import { WorkspaceEmptyPage } from "../../components/ui/WorkspaceEmptyPage";
import { usePersistedModuleTab } from "../../hooks/usePersistedModuleTab";
import { useI18n } from "../../i18n";
import { useKnowledgeStore } from "../../stores/knowledgeStore";
import { useKnowledgeWorkspaceStore } from "../../stores/knowledgeWorkspaceStore";
import { KnowledgeDocumentPanel } from "./KnowledgeDocumentPanel";
import { KnowledgeSidebar } from "./KnowledgeSidebar";
import { KnowledgeTodosView } from "./KnowledgeTodosView";
import { isKnowledgeImported } from "./knowledgeTree";
import { useKnowledgeOpenEntry } from "./useKnowledgeOpenEntry";

type KnowledgeModuleTab = "library" | "todos";
const KNOWLEDGE_TABS: KnowledgeModuleTab[] = ["library", "todos"];

export function KnowledgePanel() {
  const { t } = useI18n();
  const location = useLocation();
  const isActiveRoute = location.pathname === "/module/knowledge";
  const [mode, setMode] = usePersistedModuleTab("knowledge", "library", KNOWLEDGE_TABS);
  const loadEntries = useKnowledgeStore((s) => s.loadEntries);
  const error = useKnowledgeStore((s) => s.error);
  const clearError = useKnowledgeStore((s) => s.clearError);

  const entries = useKnowledgeStore((s) => s.entries);
  const setSelectedEntry = useKnowledgeStore((s) => s.setSelectedEntry);
  const activeTabId = useKnowledgeWorkspaceStore((s) => s.activeTabId);
  const dockLayout = useKnowledgeWorkspaceStore((s) => s.dockLayout);
  const setWorkspaceTabs = useKnowledgeWorkspaceStore((s) => s.setWorkspaceTabs);
  const setDockLayout = useKnowledgeWorkspaceStore((s) => s.setDockLayout);
  const removeTab = useKnowledgeWorkspaceStore((s) => s.removeTab);
  const { activateWorkspaceTab, promotePreviewTab, workspaceTabs } = useKnowledgeOpenEntry();
  const layoutMismatchLoggedRef = useRef(false);

  useEffect(() => {
    if (mode === "library") {
      void loadEntries();
    }
  }, [loadEntries, mode]);

  const modeIconItems = useMemo(
    () => [
      { id: "library", label: t("knowledge.tabs.library"), icon: "file-local" as const },
      { id: "todos", label: t("knowledge.tabs.todos"), icon: "table" as const },
    ],
    [t],
  );

  const effectiveDockLayout = useMemo(() => {
    if (mode !== "library" || !dockLayout || workspaceTabs.length === 0) {
      return dockLayout;
    }
    const tabIds = new Set(workspaceTabs.map((tab) => tab.id));
    const panelIds = collectPanelIds(dockLayout);
    const mismatch =
      workspaceTabs.some((tab) => !panelIds.has(tab.id)) ||
      [...panelIds].some((id) => !tabIds.has(id));
    if (mismatch) {
      layoutMismatchLoggedRef.current = true;
      return null;
    }
    layoutMismatchLoggedRef.current = false;
    return dockLayout;
  }, [dockLayout, mode, workspaceTabs]);

  useEffect(() => {
    if (mode !== "library" || !activeTabId) return;
    const tab = workspaceTabs.find((item) => item.id === activeTabId);
    if (tab) setSelectedEntry(tab.entryId);
  }, [activeTabId, mode, setSelectedEntry, workspaceTabs]);

  useEffect(() => {
    if (mode !== "library") return;
    setWorkspaceTabs((prev) => {
      let changed = false;
      const next = prev.map((tab) => {
        const entry = entries.find((item) => item.id === tab.entryId);
        if (entry && entry.title !== tab.label) {
          changed = true;
          return { ...tab, label: entry.title };
        }
        return tab;
      });
      return changed ? next : prev;
    });
  }, [entries, mode, setWorkspaceTabs]);

  const dockTabs = useMemo(() => {
    if (mode !== "library") {
      return [{ id: "todos", label: t("knowledge.tabs.todos") }];
    }
    return workspaceTabs.map((tab) => {
      const entry = entries.find((item) => item.id === tab.entryId);
      const imported = entry ? isKnowledgeImported(entry) : false;
      return {
        id: tab.id,
        label: tab.label,
        panelType: "knowledge",
        icon: "file-local" as const,
        tooltip: tab.label,
        closable: true,
        preview: Boolean(tab.preview),
        ...(!imported ? { type: "file" as const } : {}),
      };
    });
  }, [entries, mode, t, workspaceTabs]);

  const handleDockTabDoubleClick = useCallback(
    (tabId: string) => {
      const tab = workspaceTabs.find((item) => item.id === tabId);
      if (!tab?.preview) return;
      promotePreviewTab(tabId);
      activateWorkspaceTab(tabId);
    },
    [activateWorkspaceTab, promotePreviewTab, workspaceTabs],
  );

  const handleCloseTab = useCallback(
    (tabId: string) => {
      removeTab(tabId);
    },
    [removeTab],
  );

  const renderPanel = useCallback(
    (tabId: string) => {
      if (mode === "todos") {
        return <KnowledgeTodosView />;
      }
      const tab = workspaceTabs.find((item) => item.id === tabId);
      if (!tab) return null;
      return <KnowledgeDocumentPanel entryId={tab.entryId} />;
    },
    [mode, workspaceTabs],
  );

  return (
    <div className="knowledge-panel">
      {error && mode === "library" && (
        <div className="knowledge-error knowledge-error--floating">
          <span>{error}</span>
          <button type="button" onClick={clearError}>×</button>
        </div>
      )}
      <ModuleWorkspaceLayout
        layoutKey="knowledge"
        className="knowledge-workspace"
        leftColumnTitle={t("routes.knowledge")}
        leftPreset="schema"
        leftIconRail={
          <ModuleModeIconRail
            items={modeIconItems}
            activeId={mode}
            onChange={(id) => setMode(id as KnowledgeModuleTab)}
          />
        }
        leftSidebar={mode === "library" ? <KnowledgeSidebar /> : undefined}
      >
        <ModuleSegmentDock
          className="knowledge-module-dock knowledge-workspace-dock"
          variant={mode === "library" ? "workspace" : "function"}
          dockScope="knowledge"
          moduleTitle={t("routes.knowledge")}
          enabled={isActiveRoute}
          windowControl
          showTabBar={mode === "library"}
          tabs={dockTabs}
          activeTabId={mode === "library" ? (activeTabId ?? "") : "todos"}
          onActiveTabChange={mode === "library" ? activateWorkspaceTab : () => {}}
          onCloseTab={mode === "library" ? handleCloseTab : () => {}}
          onTabDoubleClick={mode === "library" ? handleDockTabDoubleClick : undefined}
          savedLayout={mode === "library" ? effectiveDockLayout : null}
          onSavedLayoutChange={mode === "library" ? setDockLayout : undefined}
          renderPanel={renderPanel}
          emptyContent={
            <WorkspaceEmptyPage
              title={t("routes.knowledge")}
              prompt={t("knowledge.selectEntry")}
            />
          }
        />
      </ModuleWorkspaceLayout>
    </div>
  );
}
