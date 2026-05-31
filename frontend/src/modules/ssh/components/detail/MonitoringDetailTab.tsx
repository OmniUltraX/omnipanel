import type { SshManagerContext } from "../../hooks/useSshManager";

type Props = Pick<
  SshManagerContext,
  | "profile"
  | "warnActivityCount"
  | "recommendedCommands"
  | "runRecommendedCommand"
>;

export function MonitoringDetailTab({
  profile,
  warnActivityCount,
  recommendedCommands,
  runRecommendedCommand,
}: Props) {
  return (
    <div className="ssh-workbench-grid">
      <div>
        <div className="quick-stats">
          <div className="quick-stat">
            <div className="stat-label">Load</div>
            <div className="stat-value">1.24</div>
          </div>
          <div className="quick-stat">
            <div className="stat-label">Network</div>
            <div className="stat-value">{profile.network}</div>
          </div>
          <div className="quick-stat">
            <div className="stat-label">Processes</div>
            <div className="stat-value">126</div>
          </div>
          <div className="quick-stat">
            <div className="stat-label">Alerts</div>
            <div className="stat-value">{warnActivityCount}</div>
          </div>
        </div>
        <div className="chart-area">
          <div className="chart-header">
            <h3>CPU Trend</h3>
            <div className="chart-tabs">
              <span className="chart-tab active">1H</span>
              <span className="chart-tab">6H</span>
              <span className="chart-tab">24H</span>
            </div>
          </div>
          <div className="chart-body">
            {[20, 24, 22, 26, 31, 28, 24, 21, 18, 23, 27, 25, 21, 19, 16, 22].map(
              (value, index) => (
                <div
                  key={index}
                  className="chart-bar"
                  style={{ height: `${value * 3}px` }}
                />
              ),
            )}
          </div>
        </div>
      </div>
      <div className="ssh-side-stack">
        <div className="panel">
          <div className="panel-header">
            <h3>监控结论</h3>
          </div>
          <div className="panel-body action-list">
            <div className="action-row">
              <span className="action-title">当前建议</span>
              <span className="action-meta">
                先看健康检查，再看容器日志，最后决定是否进入发布 / 回滚链路。
              </span>
            </div>
            <div className="action-row">
              <span className="action-title">风险提示</span>
              <span className="action-meta">
                {warnActivityCount > 0
                  ? `最近存在 ${warnActivityCount} 条预警动作，需要复核。`
                  : "近期没有明显风险动作，可继续做验证与维护。"}
              </span>
            </div>
          </div>
        </div>
        <div className="panel">
          <div className="panel-header">
            <h3>排查入口</h3>
          </div>
          <div className="panel-body term-command-pack">
            {recommendedCommands.slice(0, 4).map((command) => (
              <button
                key={command}
                type="button"
                className="term-command-chip"
                onClick={() => runRecommendedCommand(command)}
              >
                {command}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
