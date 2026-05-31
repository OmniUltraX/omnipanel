import { DETAIL_TABS } from "../constants";
import type { SshManagerContext } from "../hooks/useSshManager";
import { envBadgeClass } from "../utils/badges";
import { HostTunnelsDetailTab } from "./detail/HostTunnelsDetailTab";
import { MonitoringDetailTab } from "./detail/MonitoringDetailTab";
import { OverviewDetailTab } from "./detail/OverviewDetailTab";
import { SftpDetailTab } from "./detail/SftpDetailTab";
import { TerminalDetailTab } from "./detail/TerminalDetailTab";

type Props = SshManagerContext;

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
          <div className="host-title">{hostName}</div>
          <div className="host-addr-detail">
            {profile.username}@{hostAddress} · {profile.os} · {profile.connected}
          </div>
        </div>
        <span
          className={`badge ${activeResource?.status === "offline" ? "badge-muted" : activeResource?.status === "warning" ? "badge-warn" : "badge-success"}`}
          style={{ marginLeft: "auto" }}
        >
          {activeResource?.status === "offline"
            ? "Offline"
            : activeResource?.status === "warning"
              ? "Warning"
              : "Online"}
        </span>
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
        {detailTab === "sftp" && <SftpDetailTab {...ctx} />}
        {detailTab === "tunnels" && <HostTunnelsDetailTab {...ctx} />}
        {detailTab === "monitoring" && <MonitoringDetailTab {...ctx} />}
      </div>
    </div>
  );
}
