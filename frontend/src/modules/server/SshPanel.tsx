import { useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { ModuleSegmentDock } from "../../components/dock";
import { ModuleWorkspaceLayout } from "../../components/workspace";
import { WorkspaceEmptyPage } from "../../components/ui/WorkspaceEmptyPage";
import { usePersistedModuleTab } from "../../hooks/usePersistedModuleTab";
import { useI18n } from "../../i18n";
import { KeysModuleView } from "./ssh/components/KeysModuleView";
import { TunnelsModuleView } from "./ssh/components/TunnelsModuleView";
import { HostDetailPanel } from "./ssh/components/HostDetailPanel";
import { FleetSummaryBar } from "./ssh/components/FleetSummaryBar";
import { BatchCommandPanel } from "./ssh/components/BatchCommandPanel";
import { useSshHostWorkspace } from "./ssh/hooks/useSshHostWorkspace";
import { SshHostSidebar } from "./ssh/SshHostSidebar";
import { SshSidebarLinkageProvider } from "./ssh/SshSidebarLinkageContext";
import { useSshManager } from "./ssh/hooks/useSshManager";
import { useSshHostResources } from "../../stores/connectionStore";
import { useSshSelectionStore } from "./ssh/stores/sshSelectionStore";

type SshWorkspaceTab = "hosts" | "tunnels" | "keys";
const SSH_WORKSPACE_TABS: SshWorkspaceTab[] = ["hosts", "tunnels", "keys"];

export function SshPanel() {
  const { t } = useI18n();
  const location = useLocation();
  const isActiveRoute = location.pathname === "/module/ssh";
  const [workspaceTab, setWorkspaceTab] = usePersistedModuleTab("ssh-workspace", "hosts", SSH_WORKSPACE_TABS);
  const sshResources = useSshHostResources();
  const ctx = useSshManager();
  const isHostsTab = workspaceTab === "hosts";
  const { activeHostId, handleSelectHost } = useSshHostWorkspace(sshResources);
  const selectionMode = useSshSelectionStore((s) => s.selectionMode);
  const selectedIds = useSshSelectionStore((s) => s.selectedIds);
  const [batchOpen, setBatchOpen] = useState(false);

  const segmentTabs = useMemo(
    () => [
      { id: "hosts", label: t("ssh.tabs.hosts") },
      { id: "tunnels", label: t("ssh.tabs.tunnels") },
      { id: "keys", label: t("ssh.tabs.keys") },
    ],
    [t],
  );

  const sidebarLinkageValue = useMemo(
    () => ({
      activeHostId: isHostsTab ? activeHostId : null,
    }),
    [activeHostId, isHostsTab],
  );

  const panelContentKeysByTab = useMemo(
    () => ({
      hosts: activeHostId ?? "none",
    }),
    [activeHostId],
  );

  return (
    <SshSidebarLinkageProvider value={sidebarLinkageValue}>
      <ModuleWorkspaceLayout
        layoutKey="ssh"
        className="ssh-module-layout"
        leftColumnTitle={t("routes.ssh")}
        leftPreset="host"
        leftSidebar={
          isHostsTab ? (
            <SshHostSidebar
              resources={sshResources}
              onSelectHost={handleSelectHost}
              selectionMode={selectionMode}
              selectedIds={selectedIds}
            />
          ) : undefined
        }
      >
        <ModuleSegmentDock
          className="ssh-module-dock"
          variant="function"
          tabs={segmentTabs}
          activeTabId={workspaceTab}
          onActiveTabChange={(id) => setWorkspaceTab(id as SshWorkspaceTab)}
          enabled={isActiveRoute}
          panelContentKeysByTab={panelContentKeysByTab}
          renderPanel={(tabId) => {
            if (tabId === "tunnels") {
              return <TunnelsModuleView sshResources={ctx.sshResources} />;
            }
            if (tabId === "keys") {
              return <KeysModuleView />;
            }
            const showBatch = batchOpen && selectedIds.length > 0;
            return (
              <div className="ssh-hosts-workspace">
                <FleetSummaryBar
                  resources={sshResources}
                  onOpenBatch={() => setBatchOpen(true)}
                />
                {showBatch ? (
                  <BatchCommandPanel
                    resources={sshResources}
                    onClose={() => setBatchOpen(false)}
                  />
                ) : activeHostId ? (
                  <HostDetailPanel hostId={activeHostId} />
                ) : (
                  <WorkspaceEmptyPage
                    title={t("routes.ssh")}
                    prompt={t("ssh.empty.selectHost")}
                  />
                )}
              </div>
            );
          }}
        />
      </ModuleWorkspaceLayout>
    </SshSidebarLinkageProvider>
  );
}
