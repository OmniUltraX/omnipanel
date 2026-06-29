import { useMemo } from "react";
import { useLocation } from "react-router-dom";
import { ModuleSegmentDock } from "../../components/dock";
import { usePersistedModuleTab } from "../../hooks/usePersistedModuleTab";
import { useI18n } from "../../i18n";
import { KeysModuleView } from "./ssh/components/KeysModuleView";
import { TunnelsModuleView } from "./ssh/components/TunnelsModuleView";
import { SshHostsWorkspaceView } from "./ssh/SshHostsWorkspaceView";
import { useSshManager } from "./ssh/hooks/useSshManager";
import { useSshHostResources } from "../../stores/connectionStore";

type SshWorkspaceTab = "hosts" | "tunnels" | "keys";
const SSH_WORKSPACE_TABS: SshWorkspaceTab[] = ["hosts", "tunnels", "keys"];

export function SshPanel() {
  const { t } = useI18n();
  const location = useLocation();
  const isActiveRoute = location.pathname === "/module/ssh";
  const [workspaceTab, setWorkspaceTab] = usePersistedModuleTab("ssh-workspace", "hosts", SSH_WORKSPACE_TABS);
  const sshResources = useSshHostResources();
  const ctx = useSshManager();

  const segmentTabs = useMemo(
    () => [
      { id: "hosts", label: t("ssh.tabs.hosts") },
      { id: "tunnels", label: t("ssh.tabs.tunnels") },
      { id: "keys", label: t("ssh.tabs.keys") },
    ],
    [t],
  );

  return (
    <ModuleSegmentDock
      className="ssh-module-dock"
      moduleTitle={t("routes.ssh")}
      tabs={segmentTabs}
      activeTabId={workspaceTab}
      onActiveTabChange={(id) => setWorkspaceTab(id as SshWorkspaceTab)}
      enabled={isActiveRoute}
      renderPanel={(tabId) => {
        if (tabId === "tunnels") {
          return <TunnelsModuleView sshResources={ctx.sshResources} />;
        }
        if (tabId === "keys") {
          return <KeysModuleView />;
        }
        return <SshHostsWorkspaceView resources={sshResources} />;
      }}
    />
  );
}
