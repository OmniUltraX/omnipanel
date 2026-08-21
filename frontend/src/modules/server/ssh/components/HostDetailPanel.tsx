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
import { useSshOverview } from "../hooks/useSshOverview";
import { HostDetailToolbar } from "./HostDetailToolbar";
import { CapabilitiesDetailTab } from "./detail/CapabilitiesDetailTab";
import { HostTunnelsDetailTab } from "./detail/HostTunnelsDetailTab";
import { MonitoringDetailTab } from "./detail/MonitoringDetailTab";
import { OverviewDetailTab } from "./detail/OverviewDetailTab";
import { TmuxSessionsDetailTab } from "./detail/TmuxSessionsDetailTab";
import { SshModuleContextBridge } from "../ai/SshModuleContextBridge";
import { isProdHost } from "../utils/sshProdGuard";

type Props = {
  hostId: string;
};

export function HostDetailPanel({ hostId }: Props) {
  const { t } = useI18n();
  const [detailTab, setDetailTab] = usePersistedModuleTab(
    `ssh-detail-v2-${hostId}`,
    "capabilities",
    DETAIL_TABS,
  );
  const sshResources = useSshHostResources();
  const connections = useConnectionStore((s) => s.connections);
  const activeResource = useMemo(() => {
    return sshResources.find((resource) => resource.id === hostId) ?? null;
  }, [hostId, sshResources]);

  const hostContext = useSshHostContext(activeResource?.id ?? null, activeResource);
  const overview = useSshOverview(activeResource?.id ?? null, {
    processPolling: detailTab === "overview",
  });
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
        overviewRefresh={{
          updatedAt: overview.updatedAt,
          refreshing: overview.refreshing,
          onRefresh: overview.refresh,
        }}
      />

      <div
        className={`ssh-detail-body${
          detailTab === "overview" ? " ssh-detail-body--overview" : ""
        }`}
      >
        {detailTab === "overview" && (
          <OverviewDetailTab activeResource={activeResource} overview={overview} />
        )}
        {detailTab === "tunnels" && (
          <HostTunnelsDetailTab activeResource={activeResource} />
        )}
        {detailTab === "monitoring" && <MonitoringDetailTab activeResource={activeResource} />}
        {detailTab === "tmuxSessions" && (
          <TmuxSessionsDetailTab activeResource={activeResource} />
        )}
        {detailTab === "capabilities" && (
          <CapabilitiesDetailTab activeResource={activeResource} />
        )}
      </div>
    </div>
  );
}
