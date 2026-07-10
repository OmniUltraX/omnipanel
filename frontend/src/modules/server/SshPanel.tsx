import { useMemo } from "react";
import { useLocation } from "react-router-dom";
import { ModuleWorkspaceLayout } from "../../components/workspace";
import { useI18n } from "../../i18n";
import { SshHostSidebar } from "./ssh/SshHostSidebar";
import { SshSidebarLinkageProvider } from "./ssh/SshSidebarLinkageContext";
import { SshWorkspacePanel } from "./ssh/SshWorkspacePanel";
import { useSshHostWorkspace } from "./ssh/hooks/useSshHostWorkspace";
import { useSshHostResources } from "../../stores/connectionStore";
import { useSshSelectionStore } from "./ssh/stores/sshSelectionStore";

export function SshPanel() {
  const { t } = useI18n();
  const location = useLocation();
  const isActiveRoute = location.pathname === "/module/ssh";
  const sshResources = useSshHostResources();
  const { activeHostId, handleSelectHost } = useSshHostWorkspace(sshResources);
  const selectionMode = useSshSelectionStore((s) => s.selectionMode);
  const selectedIds = useSshSelectionStore((s) => s.selectedIds);

  const sidebarLinkageValue = useMemo(() => ({ activeHostId }), [activeHostId]);

  return (
    <SshSidebarLinkageProvider value={sidebarLinkageValue}>
      <ModuleWorkspaceLayout
        className="ssh-module-layout"
        leftColumnTitle={t("routes.ssh")}
        leftPreset="host"
        leftSidebar={
          <SshHostSidebar
            resources={sshResources}
            onSelectHost={handleSelectHost}
            selectionMode={selectionMode}
            selectedIds={selectedIds}
          />
        }
      >
        <SshWorkspacePanel enabled={isActiveRoute} />
      </ModuleWorkspaceLayout>
    </SshSidebarLinkageProvider>
  );
}
