import { useCallback, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { patchDockTabPreviewMeta } from "../../../../components/dock/dockTabLiveMeta";
import type { DockableTab } from "../../../../components/dock";
import {
  removeTabFromServerLayout,
  useServerDockLayoutStore,
} from "../../../../stores/serverDockLayoutStore";
import type { ServerEntry } from "../serverConnection";
import {
  findPreviewDockTab,
  findTabIdForServer,
  makeServerTabId,
  type ServerPanelDockOpenMode,
  type ServerPanelWorkspaceTab,
} from "../serverPanelWorkspaceTabs";

export function useServerPanelWorkspace(servers: ServerEntry[]) {
  const [workspaceTabs, setWorkspaceTabs] = useState<ServerPanelWorkspaceTab[]>([]);
  const [activeTabId, setActiveTabId] = useState("");
  const workspaceTabsRef = useRef(workspaceTabs);
  workspaceTabsRef.current = workspaceTabs;

  const dockLayout = useServerDockLayoutStore((s) => s.savedLayout);
  const setDockLayout = useServerDockLayoutStore((s) => s.setSavedLayout);

  const activateTab = useCallback((tabId: string) => {
    setActiveTabId(tabId);
  }, []);

  const promotePreviewTab = useCallback((tabId: string) => {
    flushSync(() => {
      setWorkspaceTabs((prev) =>
        prev.map((tab) => (tab.id === tabId ? { ...tab, preview: undefined } : tab)),
      );
    });
    patchDockTabPreviewMeta(tabId, false);
  }, []);

  const replacePreviewDockTab = useCallback(
    (previewTabId: string, nextTab: ServerPanelWorkspaceTab) => {
      patchDockTabPreviewMeta(previewTabId, true);
      setWorkspaceTabs((prev) =>
        prev.map((tab) =>
          tab.id === previewTabId ? { ...nextTab, id: previewTabId, preview: true } : tab,
        ),
      );
      activateTab(previewTabId);
      return previewTabId;
    },
    [activateTab],
  );

  const handleDockTabDoubleClick = useCallback(
    (tabId: string) => {
      const tab = workspaceTabsRef.current.find((item) => item.id === tabId);
      if (!tab?.preview) {
        return;
      }
      promotePreviewTab(tabId);
      activateTab(tabId);
    },
    [promotePreviewTab, activateTab],
  );

  const handleSelectServer = useCallback(
    (serverId: string, mode: ServerPanelDockOpenMode = "preview") => {
      const server = servers.find((item) => item.id === serverId);
      if (!server) return;

      const moduleTabs = workspaceTabsRef.current;
      const existingTabId = findTabIdForServer(moduleTabs, serverId);
      if (existingTabId) {
        activateTab(existingTabId);
        if (mode === "permanent") {
          const tab = moduleTabs.find((item) => item.id === existingTabId);
          if (tab?.preview) {
            promotePreviewTab(existingTabId);
          }
        }
        return existingTabId;
      }

      const previewTab = findPreviewDockTab(moduleTabs);
      const tabTemplate: ServerPanelWorkspaceTab = {
        id: "",
        kind: "server",
        label: server.name,
        serverId,
      };

      if (mode === "permanent") {
        if (previewTab && previewTab.serverId === serverId) {
          promotePreviewTab(previewTab.id);
          activateTab(previewTab.id);
          return previewTab.id;
        }

        const tabId = makeServerTabId();
        setWorkspaceTabs((prev) => [...prev, { ...tabTemplate, id: tabId }]);
        activateTab(tabId);
        return tabId;
      }

      if (previewTab && previewTab.serverId === serverId) {
        activateTab(previewTab.id);
        return previewTab.id;
      }

      if (previewTab) {
        replacePreviewDockTab(previewTab.id, tabTemplate);
        return previewTab.id;
      }

      const tabId = makeServerTabId();
      patchDockTabPreviewMeta(tabId, true);
      setWorkspaceTabs((prev) => [...prev, { ...tabTemplate, id: tabId, preview: true }]);
      activateTab(tabId);
      return tabId;
    },
    [servers, activateTab, promotePreviewTab, replacePreviewDockTab],
  );

  const handleCloseTab = useCallback(
    (tabId: string) => {
      const tabs = workspaceTabsRef.current;
      const closingIndex = tabs.findIndex((tab) => tab.id === tabId);
      if (closingIndex < 0) return;

      const nextTabs = tabs.filter((tab) => tab.id !== tabId);
      setWorkspaceTabs(nextTabs);
      setDockLayout(removeTabFromServerLayout(useServerDockLayoutStore.getState().savedLayout, tabId));

      if (activeTabId === tabId) {
        const fallback = nextTabs[Math.min(closingIndex, nextTabs.length - 1)];
        setActiveTabId(fallback?.id ?? "");
      }
    },
    [activeTabId, setDockLayout],
  );

  const activeServerId = useMemo(() => {
    const tab = workspaceTabs.find((item) => item.id === activeTabId);
    return tab?.serverId ?? null;
  }, [workspaceTabs, activeTabId]);

  const dockTabs: DockableTab[] = useMemo(
    () =>
      workspaceTabs.map((tab) => ({
        id: tab.id,
        label: tab.label,
        panelType: "server-panel",
        tooltip: tab.label,
        closable: true,
        preview: Boolean(tab.preview),
      })),
    [workspaceTabs],
  );

  return {
    workspaceTabs,
    activeTabId,
    activeServerId,
    dockTabs,
    dockLayout,
    setDockLayout,
    activateTab,
    handleSelectServer,
    handleCloseTab,
    handleDockTabDoubleClick,
  };
}
