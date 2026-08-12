import { useCallback, useEffect } from "react";
import type { WorkspaceResource } from "../../../../lib/resourceRegistry";
import { migrateLayoutStorage } from "../../../../lib/layoutMigration";
import { useSshActiveHostStore } from "../stores/sshActiveHostStore";
import { useSshPanelDockStore } from "../../../../stores/sshPanelDockStore";
import type { HostDockOpenMode } from "../workspaceTabs";

export function useSshHostWorkspace(sshResources: WorkspaceResource[]) {
  useEffect(() => {
    migrateLayoutStorage("ssh", ["omnipanel.sshDockLayout.v1"]);
  }, []);

  const activeHostId = useSshActiveHostStore((s) => s.activeHostId);
  const setActiveHostId = useSshActiveHostStore((s) => s.setActiveHostId);
  const selectHostTab = useSshPanelDockStore((s) => s.selectHost);
  const activeTabId = useSshPanelDockStore((s) => s.activeTabId);
  const dockTabs = useSshPanelDockStore((s) => s.tabs);

  useEffect(() => {
    if (activeHostId && sshResources.some((item) => item.id === activeHostId)) return;
    const fallbackFromTab = dockTabs.find((tab) => tab.id === activeTabId)?.hostId ?? null;
    const fallback =
      (fallbackFromTab && sshResources.some((item) => item.id === fallbackFromTab)
        ? fallbackFromTab
        : null) ?? sshResources[0]?.id ?? null;
    if (fallback !== activeHostId) {
      setActiveHostId(fallback);
    }
  }, [activeHostId, activeTabId, dockTabs, setActiveHostId, sshResources]);

  const handleSelectHost = useCallback(
    (hostId: string, mode?: HostDockOpenMode) => {
      const resource = sshResources.find((item) => item.id === hostId);
      if (!resource) return;
      selectHostTab(hostId, resource.name, mode ?? "preview");
      setActiveHostId(hostId);
    },
    [selectHostTab, setActiveHostId, sshResources],
  );

  return {
    activeHostId,
    handleSelectHost,
  };
}
