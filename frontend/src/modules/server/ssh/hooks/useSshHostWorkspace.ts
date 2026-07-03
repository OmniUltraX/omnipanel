import { useCallback, useEffect } from "react";
import type { WorkspaceResource } from "../../../../lib/resourceRegistry";
import { migrateLayoutStorage } from "../../../../lib/layoutMigration";
import { useSshActiveHostStore } from "../stores/sshActiveHostStore";
import type { HostDockOpenMode } from "../workspaceTabs";

export function useSshHostWorkspace(sshResources: WorkspaceResource[]) {
  useEffect(() => {
    migrateLayoutStorage("ssh", ["omnipanel.sshDockLayout.v1"]);
  }, []);

  const activeHostId = useSshActiveHostStore((s) => s.activeHostId);
  const setActiveHostId = useSshActiveHostStore((s) => s.setActiveHostId);

  useEffect(() => {
    if (activeHostId && sshResources.some((item) => item.id === activeHostId)) return;
    const fallback = sshResources[0]?.id ?? null;
    if (fallback !== activeHostId) {
      setActiveHostId(fallback);
    }
  }, [activeHostId, setActiveHostId, sshResources]);

  const handleSelectHost = useCallback(
    (hostId: string, _mode?: HostDockOpenMode) => {
      if (sshResources.some((item) => item.id === hostId)) {
        setActiveHostId(hostId);
      }
    },
    [setActiveHostId, sshResources],
  );

  return {
    activeHostId,
    handleSelectHost,
  };
}
