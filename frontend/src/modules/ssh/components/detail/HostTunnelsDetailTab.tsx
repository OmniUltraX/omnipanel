import type { SshManagerContext } from "../../hooks/useSshManager";

type Props = Pick<
  SshManagerContext,
  | "profile"
  | "activeTunnelCount"
  | "idleTunnelCount"
  | "triggerTunnelAction"
  | "openModule"
>;

export function HostTunnelsDetailTab({
  profile,
  activeTunnelCount,
  idleTunnelCount,
  triggerTunnelAction,
  openModule,
}: Props) {
  return (
    <div className="ssh-workbench-grid">
      <div className="panel">
        <div className="panel-header">
          <h3>SSH Tunnels</h3>
          <button
            className="btn btn-primary btn-sm"
            onClick={() =>
              triggerTunnelAction(
                "创建 SSH Tunnel",
                "为数据库或内部服务建立新的端口转发",
                "ssh -L 5432:prod-db-master:5432 deploy@host",
              )
            }
          >
            + New Tunnel
          </button>
        </div>
        <div className="panel-body action-list">
          {profile.tunnels.map((tunnel) => (
            <div
              key={`${tunnel.local}-${tunnel.remote}`}
              className="action-row"
              style={{ alignItems: "flex-start" }}
            >
              <span className="action-title">{tunnel.local}</span>
              <span className="action-meta">
                {tunnel.remote} · {tunnel.status}
              </span>
              <div
                className="flex gap-2"
                style={{ marginLeft: "auto", flexShrink: 0 }}
              >
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() =>
                    triggerTunnelAction(
                      "检查 Tunnel 状态",
                      `检查 ${tunnel.local} 到 ${tunnel.remote} 的转发状态`,
                      `lsof -i ${tunnel.local.split(":").at(-1) ?? "5432"}`,
                    )
                  }
                >
                  Inspect
                </button>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => openModule("/database", "prod-db-master")}
                >
                  DB
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="ssh-side-stack">
        <div className="panel">
          <div className="panel-header">
            <h3>Tunnel 闭环</h3>
          </div>
          <div className="panel-body action-list">
            <div className="action-row">
              <span className="action-title">数据库只读排查</span>
              <span className="action-meta">
                先经 Tunnel 进入目标库，再把 SQL 交给数据库模块审阅。
              </span>
            </div>
            <div className="action-row">
              <span className="action-title">内部服务调试</span>
              <span className="action-meta">
                通过本地转发把未暴露的服务接入统一终端与协议调试模块。
              </span>
            </div>
            <div className="action-row">
              <span className="action-title">当前概况</span>
              <span className="action-meta">
                活动 {activeTunnelCount} 条 · 空闲 {idleTunnelCount} 条。
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
