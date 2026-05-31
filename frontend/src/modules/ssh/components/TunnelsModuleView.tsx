import { getProfile } from "../data/hostProfiles";
import type { SshManagerContext } from "../hooks/useSshManager";

type Props = Pick<
  SshManagerContext,
  "sshResources" | "triggerTunnelAction"
>;

export function TunnelsModuleView({ sshResources, triggerTunnelAction }: Props) {
  return (
    <div className="ssh-detail">
      <div className="ssh-detail-header">
        <div>
          <div className="host-title">Port Tunnels</div>
          <div className="host-addr-detail">
            为常用数据库、缓存和内部服务建立安全转发
          </div>
        </div>
        <button
          className="btn btn-primary btn-sm"
          style={{ marginLeft: "auto" }}
          onClick={() =>
            triggerTunnelAction(
              "创建全局 Tunnel",
              "从 Tunnel 总览页新建安全转发",
              "ssh -L 8080:127.0.0.1:8080 deploy@host",
            )
          }
        >
          + New Tunnel
        </button>
      </div>
      <div className="ssh-detail-body ssh-workbench-grid">
        <div className="panel">
          <div className="panel-header">
            <h3>全部 Tunnel</h3>
          </div>
          <div className="panel-body">
            <table>
              <thead>
                <tr>
                  <th>Local</th>
                  <th>Remote</th>
                  <th>Host</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {sshResources
                  .flatMap((resource) =>
                    getProfile(resource).tunnels.map((tunnel) => ({
                      resource,
                      tunnel,
                    })),
                  )
                  .map(({ resource, tunnel }) => (
                    <tr key={`${resource.id}-${tunnel.local}-${tunnel.remote}`}>
                      <td>{tunnel.local}</td>
                      <td>{tunnel.remote}</td>
                      <td>{resource.name}</td>
                      <td>
                        <span
                          className={`badge ${tunnel.status === "Active" ? "badge-success" : "badge-muted"}`}
                        >
                          {tunnel.status}
                        </span>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="ssh-side-stack">
          <div className="panel">
            <div className="panel-header">
              <h3>使用建议</h3>
            </div>
            <div className="panel-body action-list">
              <div className="action-row">
                <span className="action-title">数据库调试</span>
                <span className="action-meta">
                  优先走只读链路，避免在生产侧直接暴露数据库端口。
                </span>
              </div>
              <div className="action-row">
                <span className="action-title">服务联调</span>
                <span className="action-meta">
                  把内部服务转发到本地后，可继续联动协议调试与终端会话。
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
