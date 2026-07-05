import { useMemo } from "react";
import { getProfile } from "../data/hostProfiles";
import { useI18n } from "../../../../i18n";
import { useConnectionStore, useSshHostResources } from "../../../../stores/connectionStore";
import { usePersistedModuleTab } from "../../../../hooks/usePersistedModuleTab";
import { parseSshConfig } from "../../panel/serverConnection";
import { WorkspaceEmptyPage } from "../../../../components/ui/workspace/WorkspaceEmptyPage";
import { DETAIL_TABS } from "../constants";
import { useSshHostContext } from "../hooks/useSshHostContext";
import { useSshHostActions } from "../hooks/useSshHostActions";
import { HostDetailToolbar } from "./HostDetailToolbar";
import { HostTunnelsDetailTab } from "./detail/HostTunnelsDetailTab";
import { MonitoringDetailTab } from "./detail/MonitoringDetailTab";
import { OverviewDetailTab } from "./detail/OverviewDetailTab";
import { SshModuleContextBridge } from "../ai/SshModuleContextBridge";
import { isProdHost } from "../utils/sshProdGuard";

type Props = {
  hostId: string;
};

export function HostDetailPanel({ hostId }: Props) {
  const { t } = useI18n();
  const [detailTab, setDetailTab] = usePersistedModuleTab(
    `ssh-detail-${hostId}`,
    "overview",
    DETAIL_TABS,
  );
  const sshResources = useSshHostResources();
  const connections = useConnectionStore((s) => s.connections);
  const activeResource = useMemo(() => {
    return sshResources.find((resource) => resource.id === hostId) ?? null;
  }, [hostId, sshResources]);

  const hostContext = useSshHostContext(activeResource?.id ?? null, activeResource);
  const actions = useSshHostActions(activeResource, hostContext, {
    onOpenTunnels: () => setDetailTab("tunnels"),
  });

  if (!activeResource) {
    return <WorkspaceEmptyPage prompt={t("ssh.empty.selectHost")} />;
  }

  const profile = getProfile(activeResource);
  const hostAddress = activeResource.subtitle?.split("@").at(-1) ?? "10.0.1.10:22";
  const connection = connections.find((c) => c.id === activeResource.id);
  const sshConfig = connection ? parseSshConfig(connection) : null;
  const username = sshConfig?.user ?? profile.username;
  const isProd = isProdHost(activeResource, connection);

  return (
    <div className={`ssh-detail${isProd ? " ssh-detail--prod" : ""}`}>
      <SshModuleContextBridge resource={activeResource} hostContext={hostContext} />
      <HostDetailToolbar
        resource={activeResource}
        username={username}
        hostAddress={hostAddress}
        context={hostContext}
        detailTab={detailTab}
        onDetailTabChange={setDetailTab}
        actions={actions}
      />

      <div
        className={`ssh-detail-body${
          detailTab === "overview" ? " ssh-detail-body--overview" : ""
        }`}
      >
        {detailTab === "overview" && (
          <OverviewDetailTab
            activeResource={activeResource}
            setDetailTab={setDetailTab}
          />
        )}
        {detailTab === "tunnels" && (
          <HostTunnelsDetailTab activeResource={activeResource} />
        )}
        {detailTab === "monitoring" && <MonitoringDetailTab activeResource={activeResource} />}
      </div>
    </div>
  );
}
