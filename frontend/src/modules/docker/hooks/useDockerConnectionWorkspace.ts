import { useCallback, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { DockerConnectionInfo } from "../../../ipc/bindings";
import { patchDockTabPreviewMeta } from "../../../components/dock/dockTabLiveMeta";
import type { DockableTab } from "../../../components/dock";
import {
  removeTabFromDockerLayout,
  useDockerDockLayoutStore,
} from "../../../stores/dockerDockLayoutStore";
import {
  findPreviewDockTab,
  findTabIdForConnection,
  makeConnectionTabId,
  type DockerConnectionDockOpenMode,
  type DockerConnectionWorkspaceTab,
} from "../dockerConnectionWorkspaceTabs";

export function useDockerConnectionWorkspace(connections: DockerConnectionInfo[]) {
  const [workspaceTabs, setWorkspaceTabs] = useState<DockerConnectionWorkspaceTab[]>([]);
  const [activeTabId, setActiveTabId] = useState("");
  const workspaceTabsRef = useRef(workspaceTabs);
  workspaceTabsRef.current = workspaceTabs;

  const dockLayout = useDockerDockLayoutStore((s) => s.savedLayout);
  const setDockLayout = useDockerDockLayoutStore((s) => s.setSavedLayout);

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
    (previewTabId: string, nextTab: DockerConnectionWorkspaceTab) => {
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

  const handleSelectConnection = useCallback(
    (connectionId: string, mode: DockerConnectionDockOpenMode = "preview") => {
      const connection = connections.find((item) => item.connectionId === connectionId);
      if (!connection) return;

      const moduleTabs = workspaceTabsRef.current;
      const existingTabId = findTabIdForConnection(moduleTabs, connectionId);
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
      const tabTemplate: DockerConnectionWorkspaceTab = {
        id: "",
        kind: "connection",
        label: connection.name,
        connectionId,
      };

      if (mode === "permanent") {
        if (previewTab && previewTab.connectionId === connectionId) {
          promotePreviewTab(previewTab.id);
          activateTab(previewTab.id);
          return previewTab.id;
        }

        const tabId = makeConnectionTabId();
        setWorkspaceTabs((prev) => [...prev, { ...tabTemplate, id: tabId }]);
        activateTab(tabId);
        return tabId;
      }

      if (previewTab && previewTab.connectionId === connectionId) {
        activateTab(previewTab.id);
        return previewTab.id;
      }

      if (previewTab) {
        replacePreviewDockTab(previewTab.id, tabTemplate);
        return previewTab.id;
      }

      const tabId = makeConnectionTabId();
      patchDockTabPreviewMeta(tabId, true);
      setWorkspaceTabs((prev) => [...prev, { ...tabTemplate, id: tabId, preview: true }]);
      activateTab(tabId);
      return tabId;
    },
    [connections, activateTab, promotePreviewTab, replacePreviewDockTab],
  );

  const handleCloseTab = useCallback(
    (tabId: string) => {
      const tabs = workspaceTabsRef.current;
      const closingIndex = tabs.findIndex((tab) => tab.id === tabId);
      if (closingIndex < 0) return;

      const nextTabs = tabs.filter((tab) => tab.id !== tabId);
      setWorkspaceTabs(nextTabs);
      setDockLayout(removeTabFromDockerLayout(useDockerDockLayoutStore.getState().savedLayout, tabId));

      if (activeTabId === tabId) {
        const fallback = nextTabs[Math.min(closingIndex, nextTabs.length - 1)];
        setActiveTabId(fallback?.id ?? "");
      }
    },
    [activeTabId, setDockLayout],
  );

  const activeConnectionId = useMemo(() => {
    const tab = workspaceTabs.find((item) => item.id === activeTabId);
    return tab?.connectionId ?? null;
  }, [workspaceTabs, activeTabId]);

  const dockTabs: DockableTab[] = useMemo(
    () =>
      workspaceTabs.map((tab) => ({
        id: tab.id,
        label: tab.label,
        panelType: "docker-connection",
        icon: "database" as const,
        tooltip: tab.label,
        closable: true,
        preview: Boolean(tab.preview),
      })),
    [workspaceTabs],
  );

  return {
    workspaceTabs,
    activeTabId,
    activeConnectionId,
    dockTabs,
    dockLayout,
    setDockLayout,
    activateTab,
    handleSelectConnection,
    handleCloseTab,
    handleDockTabDoubleClick,
  };
}
