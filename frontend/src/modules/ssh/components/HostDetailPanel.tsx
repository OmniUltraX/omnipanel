import { DETAIL_TABS } from "../constants";
import type { SshManagerContext } from "../hooks/useSshManager";
import { envBadgeClass } from "../utils/badges";
import { useSshStats } from "../../../stores/sshStatsStore";
import { useHostOnlineStatus } from "../../../stores/sshConnectionStore";
import { HostTunnelsDetailTab } from "./detail/HostTunnelsDetailTab";
import { MonitoringDetailTab } from "./detail/MonitoringDetailTab";
import { OverviewDetailTab } from "./detail/OverviewDetailTab";
import { SftpDetailTab } from "./detail/SftpDetailTab";
import { TerminalDetailTab } from "./detail/TerminalDetailTab";

type Props = SshManagerContext;

function HostOsTag({ resourceId }: { resourceId: string | undefined }) {
  const stats = useSshStats(resourceId ?? null);
  if (!stats?.osInfo) return null;
  return <span className="host-os-tag-detail">{stats.osInfo}</span>;
}

function HostStatusBadge({ resourceId }: { resourceId: string | undefined }) {
  const status = useHostOnlineStatus(resourceId ?? null);
  const text =
    status === "online" ? "端口可达"
      : status === "connecting" ? "探测中"
      : status === "error" ? "端口不可达"
      : "未知";
  const cls =
    status === "online" ? "badge badge-success"
      : status === "connecting" ? "badge badge-warn"
      : status === "error" ? "badge badge-muted"
      : "badge badge-muted";
  return <span className={cls}>{text}</span>;
}

export function HostDetailPanel(ctx: Props) {
  const {
    t,
    detailTab,
    setDetailTab,
    activeResource,
    profile,
    hostAddress,
    hostName,
  } = ctx;

  return (
    <div className="ssh-detail">
      <div className="ssh-detail-header">
        <div>
          <div className="host-title">
            {hostName}
            <HostOsTag resourceId={activeResource?.id} />
          </div>
          <div className="host-addr-detail">
            {profile.username}@{hostAddress}
          </div>
        </div>
        <HostStatusBadge resourceId={activeResource?.id} />
        <span className={envBadgeClass(activeResource)}>
          {t(`env.${activeResource?.environment ?? "unknown"}`)}
        </span>
      </div>

      <div className="ssh-detail-tabs">
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

      <div
        className={`ssh-detail-body${detailTab === "terminal" ? " ssh-detail-body--terminal" : ""}`}
      >
        {detailTab === "overview" && <OverviewDetailTab {...ctx} />}
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
        {detailTab === "tunnels" && <HostTunnelsDetailTab />}
        {detailTab === "monitoring" && <MonitoringDetailTab activeResource={activeResource} />}
      </div>
    </div>
  );
}