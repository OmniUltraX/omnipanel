import { useCallback, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { WorkspaceResource } from "../../../../lib/resourceRegistry";
import { patchDockTabPreviewMeta } from "../../../../components/dock/dockTabLiveMeta";
import type { DockableTab } from "../../../../components/dock";
import {
  removeTabFromSshLayout,
  useSshDockLayoutStore,
} from "../../../../stores/sshDockLayoutStore";
import {
  findPreviewDockTab,
  findTabIdForHost,
  makeHostTabId,
  type HostDockOpenMode,
  type SshHostWorkspaceTab,
} from "../workspaceTabs";

export function useSshHostWorkspace(sshResources: WorkspaceResource[]) {
  const [workspaceTabs, setWorkspaceTabs] = useState<SshHostWorkspaceTab[]>([]);
  const [activeTabId, setActiveTabId] = useState("");
  const workspaceTabsRef = useRef(workspaceTabs);
  workspaceTabsRef.current = workspaceTabs;

  const dockLayout = useSshDockLayoutStore((s) => s.savedLayout);
  const setDockLayout = useSshDockLayoutStore((s) => s.setSavedLayout);

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
    (previewTabId: string, nextTab: SshHostWorkspaceTab) => {
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

  const handleSelectHost = useCallback(
    (hostId: string, mode: HostDockOpenMode = "preview") => {
      const resource = sshResources.find((item) => item.id === hostId);
      if (!resource) return;

      const moduleTabs = workspaceTabsRef.current;
      const existingTabId = findTabIdForHost(moduleTabs, hostId);
      if (existingTabId) {
        activateTab(existingTabId);
        if (mode === "permanent") {
          const tab = moduleTabs.find((item) => item.id === existingTabId);
          if (tab?.preview) {
            promotePreviewTab(existingTabId);
          }
        }
        return;
      }

      const previewTab = findPreviewDockTab(moduleTabs);
      const tabTemplate: SshHostWorkspaceTab = {
        id: "",
        kind: "host",
        label: resource.name,
        hostId,
      };

      if (mode === "permanent") {
        if (previewTab && previewTab.hostId === hostId) {
          promotePreviewTab(previewTab.id);
          activateTab(previewTab.id);
          return;
        }

        const tabId = makeHostTabId();
        setWorkspaceTabs((prev) => [...prev, { ...tabTemplate, id: tabId }]);
        activateTab(tabId);
        return;
      }

      if (previewTab && previewTab.hostId === hostId) {
        activateTab(previewTab.id);
        return;
      }

      if (previewTab) {
        replacePreviewDockTab(previewTab.id, tabTemplate);
        return;
      }

      const tabId = makeHostTabId();
      patchDockTabPreviewMeta(tabId, true);
      setWorkspaceTabs((prev) => [...prev, { ...tabTemplate, id: tabId, preview: true }]);
      activateTab(tabId);
    },
    [sshResources, activateTab, promotePreviewTab, replacePreviewDockTab],
  );

  const handleCloseTab = useCallback(
    (tabId: string) => {
      const tabs = workspaceTabsRef.current;
      const closingIndex = tabs.findIndex((tab) => tab.id === tabId);
      if (closingIndex < 0) return;

      const nextTabs = tabs.filter((tab) => tab.id !== tabId);
      setWorkspaceTabs(nextTabs);
      setDockLayout(removeTabFromSshLayout(useSshDockLayoutStore.getState().savedLayout, tabId));

      if (activeTabId === tabId) {
        const fallback = nextTabs[Math.min(closingIndex, nextTabs.length - 1)];
        setActiveTabId(fallback?.id ?? "");
      }
    },
    [activeTabId, setDockLayout],
  );

  const activeHostId = useMemo(() => {
    const tab = workspaceTabs.find((item) => item.id === activeTabId);
    return tab?.hostId ?? null;
  }, [workspaceTabs, activeTabId]);

  const dockTabs: DockableTab[] = useMemo(
    () =>
      workspaceTabs.map((tab) => ({
        id: tab.id,
        label: tab.label,
        panelType: "ssh-host",
        tooltip: tab.label,
        closable: true,
        preview: Boolean(tab.preview),
      })),
    [workspaceTabs],
  );

  return {
    workspaceTabs,
    activeTabId,
    activeHostId,
    dockTabs,
    dockLayout,
    setDockLayout,
    activateTab,
    handleSelectHost,
    handleCloseTab,
    handleDockTabDoubleClick,
  };
}
