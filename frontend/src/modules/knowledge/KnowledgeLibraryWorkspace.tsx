import { useCallback, useEffect, useMemo, useRef } from "react";
import { collectPanelIds } from "../../components/dock/dockViewLayout";
import { useKnowledgeStore } from "../../stores/knowledgeStore";
import { useKnowledgeWorkspaceStore } from "../../stores/knowledgeWorkspaceStore";
import { KnowledgeDocumentPanel } from "./KnowledgeDocumentPanel";
import { KnowledgeWorkspaceDock } from "./KnowledgeWorkspaceDock";
import { isKnowledgeImported } from "./knowledgeTree";
import { useKnowledgeOpenEntry } from "./useKnowledgeOpenEntry";

export function KnowledgeLibraryWorkspace() {
  const entries = useKnowledgeStore((s) => s.entries);
  const setSelectedEntry = useKnowledgeStore((s) => s.setSelectedEntry);

  const activeTabId = useKnowledgeWorkspaceStore((s) => s.activeTabId);
  const dockLayout = useKnowledgeWorkspaceStore((s) => s.dockLayout);
  const setWorkspaceTabs = useKnowledgeWorkspaceStore((s) => s.setWorkspaceTabs);
  const setDockLayout = useKnowledgeWorkspaceStore((s) => s.setDockLayout);
  const removeTab = useKnowledgeWorkspaceStore((s) => s.removeTab);

  const { activateWorkspaceTab, promotePreviewTab, workspaceTabs } = useKnowledgeOpenEntry();

  const layoutMismatchLoggedRef = useRef(false);

  const effectiveDockLayout = useMemo(() => {
    if (!dockLayout || workspaceTabs.length === 0) {
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
  }, [dockLayout, workspaceTabs]);

  const handleDockTabDoubleClick = useCallback(
    (tabId: string) => {
      const tab = workspaceTabs.find((item) => item.id === tabId);
      if (!tab?.preview) {
        return;
      }
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

  useEffect(() => {
    if (!activeTabId) {
      return;
    }
    const tab = workspaceTabs.find((item) => item.id === activeTabId);
    if (tab) {
      setSelectedEntry(tab.entryId);
    }
  }, [activeTabId, setSelectedEntry, workspaceTabs]);

  useEffect(() => {
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
  }, [entries, setWorkspaceTabs]);

  const dockTabs = useMemo(
    () =>
      workspaceTabs.map((tab) => {
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
      }),
    [entries, workspaceTabs],
  );

  const renderDockPanel = useCallback(
    (tabId: string) => {
      const tab = workspaceTabs.find((item) => item.id === tabId);
      if (!tab) {
        return null;
      }
      return <KnowledgeDocumentPanel entryId={tab.entryId} />;
    },
    [workspaceTabs],
  );

  return (
    <KnowledgeWorkspaceDock
      dockTabs={dockTabs}
      activeTabId={activeTabId}
      onActiveTabChange={activateWorkspaceTab}
      onCloseTab={handleCloseTab}
      dockLayout={effectiveDockLayout}
      onDockLayoutChange={setDockLayout}
      renderPanel={renderDockPanel}
      onTabDoubleClick={handleDockTabDoubleClick}
    />
  );
}
