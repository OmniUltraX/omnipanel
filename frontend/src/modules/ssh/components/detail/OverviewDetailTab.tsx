import type { WorkspaceResource } from "../../../../lib/resourceRegistry";
import { useSshStats, formatBytes, formatPercent } from "../../../../stores/sshStatsStore";
import type { SshManagerContext } from "../../hooks/useSshManager";
import { presetBadgeClass } from "../../utils/badges";

type Props = Pick<
  SshManagerContext,
  | "profile"
  | "hostAddress"
  | "activeResource"
  | "hostName"
  | "activeTunnelCount"
  | "operationalChecklist"
  | "hostSignals"
  | "warnActivityCount"
  | "openTerminal"
  | "openModule"
  | "setDetailTab"
  | "triggerTunnelAction"
>;

export function OverviewDetailTab({
  profile,
  hostAddress,
  activeResource,
  hostName,
  activeTunnelCount,
  operationalChecklist,
  hostSignals,
  warnActivityCount,
  openTerminal,
  openModule,
  setDetailTab,
  triggerTunnelAction,
}: Props) {
  const stats = useSshStats(activeResource?.id ?? null);

  const cpuLabel = stats
    ? `${stats.cpuUsage.toFixed(1)}% (${stats.cpuCores} cores)`
    : profile.cpu;
  const memLabel = stats
    ? `${formatBytes(stats.memory.used)} / ${formatBytes(stats.memory.total)} (${formatPercent(stats.memory.used, stats.memory.total)})`
    : profile.memory;
  const diskLabel = stats
    ? `${formatBytes(stats.disk.used)} / ${formatBytes(stats.disk.total)} (${formatPercent(stats.disk.used, stats.disk.total)})`
    : profile.disk;
  const loadLabel = stats?.load || "—";

  return (
    <>
      <div className="quick-stats">
        <div className="quick-stat">
          <div className="stat-label">CPU</div>
          <div className="stat-value">{cpuLabel}</div>
        </div>
        <div className="quick-stat">
          <div className="stat-label">Memory</div>
          <div className="stat-value">{memLabel}</div>
        </div>
        <div className="quick-stat">
          <div className="stat-label">Load</div>
          <div className="stat-value">{loadLabel}</div>
        </div>
        <div className="quick-stat">
          <div className="stat-label">Disk</div>
          <div className="stat-value">{diskLabel}</div>
        </div>
        <div className="quick-stat">
          <div className="stat-label">Tunnel</div>
          <div className="stat-value">{activeTunnelCount}</div>
        </div>
        <div className="quick-stat">
          <div className="stat-label">Uptime</div>
          <div className="stat-value">{profile.uptime}</div>
        </div>
      </div>

      <div className="ssh-workbench-grid">
        <div className="panel">
          <div className="panel-header">
            <h3>连接详情</h3>
            <span className="badge badge-muted">{profile.authMethod}</span>
          </div>
          <div className="panel-body">
            <div className="form-grid">
              <div className="form-field">
                <label className="form-label">Host</label>
                <input
                  className="input"
                  value={hostAddress.split(":")[0]}
                  readOnly
                />
              </div>
              <div className="form-field">
                <label className="form-label">Port</label>
                <input
                  className="input"
                  value={hostAddress.split(":").at(-1) ?? "22"}
                  readOnly
                />
              </div>
              <div className="form-field">
                <label className="form-label">Username</label>
                <input className="input" value={profile.username} readOnly />
              </div>
              <div className="form-field">
                <label className="form-label">Key File</label>
                <input className="input" value={profile.keyFile} readOnly />
              </div>
              <div className="form-field" style={{ gridColumn: "1 / -1" }}>
                <label className="form-label">Key Scope</label>
                <input className="input" value={profile.keyScope} readOnly />
              </div>
              <div className="form-field" style={{ gridColumn: "1 / -1" }}>
                <label className="form-label">Tags</label>
                <div className="flex gap-2" style={{ flexWrap: "wrap" }}>
                  {profile.tags.map((tag) => (
                    <span key={tag} className="tag">
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            </div>
            <div className="conn-actions">
              <button className="btn btn-primary" onClick={() => openTerminal()}>
                打开终端工作区
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => setDetailTab("sftp")}
              >
                浏览文件
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => setDetailTab("tunnels")}
              >
                管理 Tunnel
              </button>
              <button
                className="btn btn-ghost text-danger"
                style={{ marginLeft: "auto" }}
                onClick={() =>
                  triggerTunnelAction(
                    "断开 SSH 会话",
                    "准备断开当前主机连接并回收会话上下文",
                    "exit",
                  )
                }
              >
                断开连接
              </button>
            </div>
          </div>
        </div>

        <div className="ssh-side-stack">
          <div className="panel">
            <div className="panel-header">
              <h3>会话预设</h3>
              <span className="badge badge-accent">SSH + Terminal</span>
            </div>
            <div className="panel-body ssh-session-grid">
              {profile.presets.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className="ssh-launch-card"
                  onClick={() => openTerminal(preset)}
                >
                  <div className="ssh-launch-head">
                    <span>{preset.title}</span>
                    <span className={presetBadgeClass(preset.tone)}>
                      {preset.purpose}
                    </span>
                  </div>
                  <div className="ssh-launch-desc">{preset.desc}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <h3>操作闭环</h3>
            </div>
            <div className="panel-body action-list">
              {operationalChecklist.map((item) => (
                <div key={item} className="action-row">
                  <span className="action-title">下一步</span>
                  <span className="action-meta">{item}</span>
                </div>
              ))}
            </div>
          </div>

          {stats && (
            <div className="panel">
              <div className="panel-header">
                <h3>实时资源</h3>
                <span className="badge badge-success">3s 刷新</span>
              </div>
              <div className="panel-body action-list">
                <div className="action-row">
                  <span className="action-title">CPU 使用率</span>
                  <span className="action-meta">{stats.cpuUsage.toFixed(1)}%</span>
                </div>
                <div className="action-row">
                  <span className="action-title">CPU 核心</span>
                  <span className="action-meta">{stats.cpuCores}</span>
                </div>
                <div className="action-row">
                  <span className="action-title">负载均值</span>
                  <span className="action-meta">{stats.load}</span>
                </div>
                <div className="action-row">
                  <span className="action-title">内存</span>
                  <span className="action-meta">
                    {formatBytes(stats.memory.used)} / {formatBytes(stats.memory.total)}
                    {" ("}{formatPercent(stats.memory.used, stats.memory.total)}{")"}
                  </span>
                </div>
                <div className="action-row">
                  <span className="action-title">磁盘</span>
                  <span className="action-meta">
                    {formatBytes(stats.disk.used)} / {formatBytes(stats.disk.total)}
                    {" ("}{formatPercent(stats.disk.used, stats.disk.total)}{")"}
                  </span>
                </div>
              </div>
            </div>
          )}

          <div className="panel">
            <div className="panel-header">
              <h3>关联模块</h3>
            </div>
            <div className="panel-body ssh-module-list">
              {profile.relatedModules.map((item) => (
                <button
                  key={`${item.path}-${item.label}`}
                  type="button"
                  className="ssh-module-item"
                  onClick={() => openModule(item.path, item.resourceId)}
                >
                  <span className="action-title">{item.label}</span>
                  <span className="action-meta">{item.desc}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="info-grid" style={{ marginTop: "var(--sp-4)" }}>
        <div className="panel">
          <div className="panel-header">
            <h3>最近操作</h3>
          </div>
          <div className="panel-body">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Command</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {profile.recentActivity.map((item) => (
                  <tr key={`${item.time}-${item.command}`}>
                    <td className="text-muted">{item.time}</td>
                    <td>{item.command}</td>
                    <td>
                      <span
                        className={`badge ${item.status === "ok" ? "badge-success" : "badge-warn"}`}
                      >
                        {item.status === "ok" ? "OK" : "Warn"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <h3>主机画像</h3>
            <span
              className={`badge ${warnActivityCount > 0 ? "badge-warn" : "badge-success"}`}
            >
              {warnActivityCount > 0 ? "需关注" : "稳定"}
            </span>
          </div>
          <div className="panel-body action-list">
            {hostSignals.map((signal) => (
              <div key={signal.title} className="action-row">
                <span className="action-title">{signal.title}</span>
                <span className="action-meta">{signal.desc}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
