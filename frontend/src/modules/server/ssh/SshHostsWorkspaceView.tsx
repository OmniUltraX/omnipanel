import { useMemo } from "react";
import { ModuleWorkspaceLayout } from "../../../components/workspace";
import { WorkspaceEmptyPage } from "../../../components/ui/WorkspaceEmptyPage";
import { useI18n } from "../../../i18n";
import type { WorkspaceResource } from "../../../lib/resourceRegistry";
import { HostDetailPanel } from "./components/HostDetailPanel";
import { useSshHostWorkspace } from "./hooks/useSshHostWorkspace";
import { SshHostSidebar } from "./SshHostSidebar";
import { SshSidebarLinkageProvider } from "./SshSidebarLinkageContext";

/** @deprecated 布局已上移至 SshPanel，保留仅供引用迁移 */
export interface SshHostsWorkspaceViewProps {
  resources: WorkspaceResource[];
}

export function SshHostsWorkspaceView({ resources }: SshHostsWorkspaceViewProps) {
  const { t } = useI18n();
  const { activeHostId, handleSelectHost } = useSshHostWorkspace(resources);

  const sidebarLinkageValue = useMemo(
    () => ({
      activeHostId,
    }),
    [activeHostId],
  );

  return (
    <SshSidebarLinkageProvider value={sidebarLinkageValue}>
      <ModuleWorkspaceLayout
        layoutKey="ssh-hosts"
        className="ssh-hosts-workspace"
        leftColumnTitle={t("routes.ssh")}
        leftPreset="host"
        leftSidebar={
          <SshHostSidebar resources={resources} onSelectHost={handleSelectHost} />
        }
      >
        {activeHostId ? (
          <HostDetailPanel hostId={activeHostId} />
        ) : (
          <WorkspaceEmptyPage
            title={t("routes.ssh")}
            prompt={t("ssh.empty.selectHost")}
          />
        )}
      </ModuleWorkspaceLayout>
    </SshSidebarLinkageProvider>
  );
}
