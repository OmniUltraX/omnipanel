import { useI18n } from "../../../i18n";
import { Button } from "../../../components/ui/primitives/Button";
import { redisFlushAll } from "../api";
import type { DbConnectionConfig } from "../api";
import { formatBytesLabel, formatUptime, hitRate, infoValue } from "../redis/redisInfoHelpers";
import type { RedisInfoResult } from "../api";

interface RedisOverviewPanelProps {
  connection: DbConnectionConfig;
  info: RedisInfoResult | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

export function RedisOverviewCards({
  connection,
  info,
  loading,
  error,
  onRefresh,
}: RedisOverviewPanelProps) {
  const { t } = useI18n();

  const cards = [
    {
      label: t("database.redisOps.version"),
      value: infoValue(info, "Server", "redis_version") ?? "—",
    },
    {
      label: t("database.redisOps.usedMemory"),
      value: formatBytesLabel(infoValue(info, "Memory", "used_memory")),
    },
    {
      label: t("database.redisOps.opsPerSec"),
      value: infoValue(info, "Stats", "instantaneous_ops_per_sec") ?? "—",
    },
    {
      label: t("database.redisOps.connectedClients"),
      value: infoValue(info, "Clients", "connected_clients") ?? "—",
    },
    { label: t("database.redisOps.hitRate"), value: hitRate(info) },
    {
      label: t("database.redisOps.uptime"),
      value: formatUptime(infoValue(info, "Server", "uptime_in_seconds")),
    },
  ];

  return (
    <div className="redis-ops-overview">
      <div className="redis-ops-overview__toolbar">
        <Button variant="ghost" size="sm" onClick={onRefresh} disabled={loading}>
          {t("common.refresh")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            void redisFlushAll(connection).then(() => onRefresh());
          }}
        >
          FLUSHALL
        </Button>
      </div>
      {error ? <div className="redis-ops-overview__error">{error}</div> : null}
      <div className="redis-ops-overview__cards">
        {cards.map((card) => (
          <div key={card.label} className="redis-ops-overview__card">
            <div className="redis-ops-overview__card-label">{card.label}</div>
            <div className="redis-ops-overview__card-value">{card.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
