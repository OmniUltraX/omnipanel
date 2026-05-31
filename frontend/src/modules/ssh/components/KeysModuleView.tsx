import { SSH_KEYS } from "../data/sshKeys";
import type { SshManagerContext } from "../hooks/useSshManager";

type Props = Pick<
  SshManagerContext,
  "profile" | "hostName" | "keyCoverage" | "triggerKeyAction"
>;

export function KeysModuleView({
  profile,
  hostName,
  keyCoverage,
  triggerKeyAction,
}: Props) {
  return (
    <div className="ssh-detail">
      <div className="ssh-detail-header">
        <div>
          <div className="host-title">SSH Keys</div>
          <div className="host-addr-detail">
            统一管理密钥、用途、覆盖主机与风险范围
          </div>
        </div>
        <button
          className="btn btn-primary btn-sm"
          style={{ marginLeft: "auto" }}
          onClick={() =>
            triggerKeyAction(
              "导入 SSH 密钥",
              "从密钥总览页导入新的 SSH Key",
              "ssh-add ~/.ssh/new_key",
            )
          }
        >
          + Import Key
        </button>
      </div>
      <div className="ssh-detail-body ssh-workbench-grid">
        <div className="panel">
          <div className="panel-header">
            <h3>Available Keys</h3>
          </div>
          <div className="panel-body action-list">
            {SSH_KEYS.map((key) => (
              <div key={key.name} className="action-row">
                <span className="action-title">{key.name}</span>
                <span className="action-meta">
                  {key.meta} · {key.usage}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div className="ssh-side-stack">
          <div className="panel">
            <div className="panel-header">
              <h3>覆盖情况</h3>
            </div>
            <div className="panel-body action-list">
              <div className="action-row">
                <span className="action-title">当前主机</span>
                <span className="action-meta">
                  {hostName} 使用 {profile.keyFile}，覆盖范围 {profile.keyScope}。
                </span>
              </div>
              <div className="action-row">
                <span className="action-title">密钥命中</span>
                <span className="action-meta">
                  当前画像已匹配 {keyCoverage}{" "}
                  组密钥信息，可继续做轮换或权限治理。
                </span>
              </div>
              <div className="action-row">
                <span className="action-title">与终端协同</span>
                <span className="action-meta">
                  密钥与主机上下文进入终端工作区后，才能形成真正可复用的运维工作台。
                </span>
              </div>
            </div>
          </div>
          <div className="panel">
            <div className="panel-header">
              <h3>治理建议</h3>
            </div>
            <div className="panel-body action-list">
              <div className="action-row">
                <span className="action-title">连接治理</span>
                <span className="action-meta">
                  SSH 模块不只是连上主机，还要对密钥边界、风险范围与工作流授权负责。
                </span>
              </div>
              <div className="action-row">
                <span className="action-title">轮换策略</span>
                <span className="action-meta">
                  建议按环境划分密钥，避免生产、预发与跳板机共用长期凭据。
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
