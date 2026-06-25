import { useMemo } from "react";
import { DETAIL_TABS, SSH_PATH } from "../constants";
import type { SshManagerContext } from "../hooks/useSshManager";
import { getProfile } from "../data/hostProfiles";
import { normalizeSshGroup, sshGroupLabel } from "../../../../lib/sshGroups";
import { useI18n } from "../../../../i18n";
import { ResourceTags } from "../../../../components/ui/ResourceTags";
import { useConnectionStore, useSshHostResources } from "../../../../stores/connectionStore";
import { useWorkspaceStore } from "../../../../stores/workspaceStore";
import { usePersistedModuleTab } from "../../../../hooks/usePersistedModuleTab";
import { parseSshConfig } from "../../panel/serverConnection";
import { WorkspaceEmptyPage } from "../../../../components/ui/WorkspaceEmptyPage";
import { HostStatusIndicator } from "./HostStatusIndicator";
import { useSshMonitoring } from "../hooks/useSshMonitoring";
import { HostTunnelsDetailTab } from "./detail/HostTunnelsDetailTab";
import { MonitoringDetailTab } from "./detail/MonitoringDetailTab";
import { OverviewDetailTab } from "./detail/OverviewDetailTab";
import { SftpDetailTab } from "./detail/SftpDetailTab";
import { TerminalDetailTab } from "./detail/TerminalDetailTab";

type Props = SshManagerContext;

function HostDetailTags({ resourceId }: { resourceId: string | undefined }) {
  const tags = useConnectionStore(
    (s) => s.connections.find((c) => c.id === resourceId)?.tags,
  );
  return <ResourceTags tags={tags} variant="detail" />;
}

function MonitoringTabSwitch({ resourceId }: { resourceId: string | null }) {
  const { t } = useI18n();
  const { enabled, enable, disable } = useSshMonitoring(resourceId);

  return (
    <label className="ssh-monitor-switch" title={t("ssh.monitoring.hint")}>
      <span className="ssh-monitor-switch-label">{t("ssh.monitoring.title")}</span>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        className={`ssh-monitor-switch-btn${enabled ? " active" : ""}`}
        onClick={() => {
          if (enabled) void disable();
          else void enable();
        }}
        disabled={!resourceId}
      >
        <span className="ssh-monitor-switch-thumb" />
      </button>
    </label>
  );
}

export function HostDetailPanel(ctx: Props) {
  const { t } = ctx;
  /** dockview 面板内容不随父级重绘；Tab / 选中主机须在组件内订阅 store */
  const [detailTab, setDetailTab] = usePersistedModuleTab("ssh-detail", "overview", DETAIL_TABS);
  const selectedSshId = useWorkspaceStore((s) => s.selectedResourceByPath[SSH_PATH]);
  const sshResources = useSshHostResources();
  const activeResource = useMemo(() => {
    if (!selectedSshId) return null;
    return sshResources.find((resource) => resource.id === selectedSshId) ?? null;
  }, [selectedSshId, sshResources]);

  if (!activeResource) {
    return <WorkspaceEmptyPage prompt={t("ssh.empty.selectHost")} />;
  }

  const profile = getProfile(activeResource);
  const hostAddress = activeResource.subtitle?.split("@").at(-1) ?? "10.0.1.10:22";
  const hostName = activeResource.name ?? "prod-web-01";

  const connections = useConnectionStore((s) => s.connections);
  const connection = connections.find((c) => c.id === activeResource.id);
  const sshConfig = connection ? parseSshConfig(connection) : null;
  const username = sshConfig?.user ?? profile.username;
  const resourceId = activeResource.id;

  return (
    <div className="ssh-detail">
      <div className="ssh-detail-header">
        <div>
          <div className="host-title">
            {hostName}
            <HostDetailTags resourceId={activeResource?.id} />
          </div>
          <div className="host-addr-detail">
            {username}@{hostAddress}
          </div>
        </div>
        <HostStatusIndicator resourceId={resourceId} showLabel />
        {activeResource && (
          <span className="badge badge-muted">
            {sshGroupLabel(normalizeSshGroup(activeResource.group), t)}
          </span>
        )}
      </div>

      <div className="ssh-detail-tabs">
        <div className="ssh-detail-tabs-list">
          {DETAIL_TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              className={`ssh-detail-tab${detailTab === tab ? " active" : ""}`}
              onClick={() => setDetailTab(tab)}
            >
              {t(`ssh.detailTabs.${tab}`)}
            </button>
          ))}
        </div>
        <MonitoringTabSwitch resourceId={resourceId} />
      </div>

      <div
        className={`ssh-detail-body${
          detailTab === "terminal"
            ? " ssh-detail-body--terminal"
            : detailTab === "overview"
              ? " ssh-detail-body--overview"
              : ""
        }`}
      >
        {detailTab === "overview" && (
          <OverviewDetailTab
            profile={profile}
            activeResource={activeResource}
            setDetailTab={setDetailTab}
          />
        )}
        <div
          className="ssh-terminal-tab-slot"
          hidden={detailTab !== "terminal"}
        >
          <TerminalDetailTab
            activeResource={activeResource}
            detailTabActive={detailTab === "terminal"}
          />
        </div>
        {detailTab === "sftp" && <SftpDetailTab activeResource={activeResource} />}
        {detailTab === "tunnels" && (
          <HostTunnelsDetailTab activeResource={activeResource} />
        )}
        {detailTab === "monitoring" && <MonitoringDetailTab activeResource={activeResource} />}
      </div>
    </div>
  );
}
