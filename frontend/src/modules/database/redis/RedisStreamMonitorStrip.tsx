import { useI18n } from "../../../i18n";
import type { RedisStreamMonitorState } from "./useRedisStreamMonitor";

interface RedisStreamMonitorStripProps {
  monitor: RedisStreamMonitorState;
}

/** Stream 键顶栏第二行：inline 指标 + 自动刷新，不换行滚动 */
export function RedisStreamMonitorStrip({ monitor }: RedisStreamMonitorStripProps) {
  const { t } = useI18n();
  const { snapshot, selectedGroupRow, autoRefresh, setAutoRefresh, rateStats } = monitor;

  const activeCount = snapshot?.consumers.filter((c) => c.active).length ?? 0;
  const consumerTotal = snapshot?.consumers.length ?? 0;

  const stats: Array<{ key: string; label: string; value: string; title?: string }> = [
    {
      key: "lag",
      label: "Lag",
      value: selectedGroupRow?.lag != null ? selectedGroupRow.lag.toLocaleString() : "—",
    },
    {
      key: "pending",
      label: "Pend",
      value: selectedGroupRow?.pending != null ? selectedGroupRow.pending.toLocaleString() : "—",
    },
    {
      key: "behind",
      label: t("database.redisOps.colBehind"),
      value:
        selectedGroupRow?.behindSeconds != null ? `${selectedGroupRow.behindSeconds}s` : "—",
    },
    {
      key: "active",
      label: t("database.redisOps.activeConsumersShort"),
      value: `${rateStats?.activeConsumers ?? activeCount}/${consumerTotal}`,
    },
  ];

  if (rateStats) {
    stats.push(
      { key: "rate", label: "Rate/s", value: rateStats.rate.toFixed(1) },
      { key: "lag-delta", label: "ΔLag", value: String(rateStats.lagDelta) },
    );
  }

  return (
    <div className="redis-stream-monitor redis-stream-monitor--compact">
      <div className="redis-stream-monitor__stats">
        {stats.map((item) => (
          <span key={item.key} className="redis-stream-monitor__stat" title={item.title ?? item.value}>
            <span className="redis-stream-monitor__stat-label">{item.label}</span>
            <span className="redis-stream-monitor__stat-value">{item.value}</span>
          </span>
        ))}
      </div>
      <label className="redis-stream-monitor__auto">
        <input
          type="checkbox"
          checked={autoRefresh}
          onChange={(e) => setAutoRefresh(e.target.checked)}
        />
        {t("database.redisOps.autoRefreshShort")}
      </label>
    </div>
  );
}
