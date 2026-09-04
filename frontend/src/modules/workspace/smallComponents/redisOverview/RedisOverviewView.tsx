import { useEffect, useState } from "react";
import { useI18n } from "../../../../i18n";
import { formatBytes } from "../../../../stores/sshStatsStore";
import { useDashboardStore } from "../../useDashboardStore";
import type { SmallComponentController, SmallComponentRenderProps } from "../types";
import { useDbConnectionForWidget } from "../useDbConnectionForWidget";
import {
  fetchRedisOverviewSnapshot,
  REDIS_FRAG_RATIO_BAR_FULL,
  type RedisOverviewSnapshot,
} from "./fetchRedisOverview";
import { REDIS_OVERVIEW_DB_TYPES, REDIS_OVERVIEW_REFRESH_MS } from "./layout";

type RedisOverviewController = SmallComponentController & {
  subscribe: (listener: () => void) => () => void;
  revision: number;
};

function asRedisController(
  controller: SmallComponentController | undefined,
): RedisOverviewController | null {
  if (!controller) return null;
  const c = controller as RedisOverviewController;
  if (typeof c.subscribe !== "function") return null;
  return c;
}

function formatCount(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return String(Math.round(value));
}

function clampPercent(used: number | null, total: number | null): number | null {
  if (used == null || total == null || !Number.isFinite(used) || !Number.isFinite(total)) {
    return null;
  }
  if (total <= 0) return null;
  return Math.max(0, Math.min(100, (used / total) * 100));
}

function toneFromPercent(
  percent: number | null,
): "ok" | "warn" | "off" | "neutral" {
  if (percent == null) return "neutral";
  if (percent >= 90) return "warn";
  if (percent >= 70) return "ok";
  return "neutral";
}

/** 碎片率：<1 偏低；1~1.5 正常；>1.5 偏高 */
function toneFromFragmentation(
  ratio: number | null,
): "ok" | "warn" | "off" | "neutral" {
  if (ratio == null) return "neutral";
  if (ratio > 1.5 || ratio < 1) return "warn";
  return "ok";
}

function MetricCell({
  label,
  value,
  hint,
  tone,
  percent,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "ok" | "off" | "warn" | "neutral";
  percent?: number | null;
}) {
  const showBar = percent != null && Number.isFinite(percent);
  const width = showBar ? Math.max(0, Math.min(100, percent)) : 0;
  return (
    <div className="sc-redis-ov__cell" data-tone={tone ?? "neutral"}>
      <div className="sc-redis-ov__cell-label">{label}</div>
      <div className="sc-redis-ov__cell-value">{value}</div>
      {showBar ? (
        <div className="sc-redis-ov__bar-track" aria-hidden>
          <div
            className="sc-redis-ov__bar-fill"
            data-tone={tone ?? "neutral"}
            style={{ width: `${width}%` }}
          />
        </div>
      ) : null}
      {hint ? <div className="sc-redis-ov__cell-hint">{hint}</div> : null}
    </div>
  );
}

export function RedisOverviewView({
  instanceId,
  panelId,
  controller,
  dataSourceId: dataSourceIdProp,
}: SmallComponentRenderProps) {
  const { t } = useI18n();
  const widget = useDashboardStore(
    (s) =>
      s.customPanels[panelId]?.widgets.find((w) => w.id === instanceId) ?? null,
  );
  const monitor = asRedisController(controller);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!monitor) return;
    return monitor.subscribe(() => setTick((n) => n + 1));
  }, [monitor]);

  const connectionId = dataSourceIdProp ?? widget?.dataSourceId ?? null;
  const { connection } = useDbConnectionForWidget(connectionId);

  const [snapshot, setSnapshot] = useState<RedisOverviewSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    async function load() {
      if (!connection) return;
      setLoading(true);
      setError(null);
      try {
        const next = await fetchRedisOverviewSnapshot({
          id: connection.id,
          name: connection.name,
          db_type: connection.db_type,
          host: connection.host,
          port: connection.port,
          user: connection.user,
          password: connection.password ?? "",
          database: connection.database ?? "",
          ssl: Boolean(connection.ssl),
          status: connection.status ?? "unknown",
          enabled: connection.enabled,
          has_password: connection.has_password,
        });
        if (!cancelled) setSnapshot(next);
      } catch (e) {
        if (!cancelled) {
          setSnapshot(null);
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    if (!connection) {
      setSnapshot(null);
      setError(null);
      setLoading(false);
      return;
    }

    const dbType = connection.db_type.trim().toLowerCase();
    if (!(REDIS_OVERVIEW_DB_TYPES as readonly string[]).includes(dbType)) {
      setSnapshot(null);
      setError(null);
      setLoading(false);
      return;
    }

    void load();
    timer = window.setInterval(() => {
      void load();
    }, REDIS_OVERVIEW_REFRESH_MS);

    return () => {
      cancelled = true;
      if (timer != null) window.clearInterval(timer);
    };
  }, [connection, monitor?.revision]);

  if (!connectionId) {
    return (
      <div className="sc-redis-ov sc-redis-ov--empty">
        <p className="sc-redis-ov__empty-title">
          {t("homeWorkspace.customPanel.dataSource.requiredTitle")}
        </p>
        <p className="sc-redis-ov__empty-hint">
          {t("homeWorkspace.widgets.redisOverview.needConnection")}
        </p>
      </div>
    );
  }

  if (!connection) {
    return (
      <div className="sc-redis-ov sc-redis-ov--empty">
        <p className="sc-redis-ov__empty-title">
          {t("homeWorkspace.widgets.redisOverview.notFound")}
        </p>
        <p className="sc-redis-ov__empty-hint">
          {t("homeWorkspace.widgets.redisOverview.notFoundHint")}
        </p>
      </div>
    );
  }

  const dbType = connection.db_type.trim().toLowerCase();
  if (!(REDIS_OVERVIEW_DB_TYPES as readonly string[]).includes(dbType)) {
    return (
      <div className="sc-redis-ov sc-redis-ov--empty">
        <p className="sc-redis-ov__empty-title">
          {t("homeWorkspace.widgets.redisOverview.needRedis")}
        </p>
        <p className="sc-redis-ov__empty-hint">
          {t("homeWorkspace.widgets.redisOverview.needRedisHint")}
        </p>
      </div>
    );
  }

  if (error && !snapshot) {
    return (
      <div className="sc-redis-ov sc-redis-ov--empty">
        <p className="sc-redis-ov__empty-title">
          {t("homeWorkspace.widgets.redisOverview.loadFailed")}
        </p>
        <p className="sc-redis-ov__empty-hint">{error}</p>
      </div>
    );
  }

  if (!snapshot && loading) {
    return (
      <div className="sc-redis-ov sc-redis-ov--empty">
        <p className="sc-redis-ov__empty-title">
          {t("homeWorkspace.widgets.redisOverview.loading")}
        </p>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="sc-redis-ov sc-redis-ov--empty">
        <p className="sc-redis-ov__empty-title">
          {t("homeWorkspace.widgets.redisOverview.emptyTitle")}
        </p>
      </div>
    );
  }

  const memPercent = clampPercent(
    snapshot.usedMemoryBytes,
    snapshot.maxMemoryBytes,
  );
  const memUsed =
    snapshot.usedMemoryBytes != null
      ? formatBytes(snapshot.usedMemoryBytes)
      : snapshot.usedMemoryHuman;
  const memTotal =
    snapshot.maxMemoryBytes != null
      ? formatBytes(snapshot.maxMemoryBytes)
      : "—";
  const memValue = `${memUsed} / ${memTotal}`;
  const memHint =
    snapshot.maxMemorySource === "host-ram"
      ? t("homeWorkspace.widgets.redisOverview.memoryHostRamHint")
      : snapshot.maxMemorySource == null
        ? t("homeWorkspace.widgets.redisOverview.memoryNeedCeilingHint")
        : undefined;

  const connPercent = clampPercent(
    snapshot.connectedClients,
    snapshot.maxClients,
  );
  const connValue =
    snapshot.connectedClients != null && snapshot.maxClients != null
      ? `${formatCount(snapshot.connectedClients)} / ${formatCount(snapshot.maxClients)}`
      : formatCount(snapshot.connectedClients);

  const hits = snapshot.keyspaceHits ?? 0;
  const misses = snapshot.keyspaceMisses ?? 0;
  const hitTotal = hits + misses;
  const hitPercent =
    hitTotal > 0 ? Math.max(0, Math.min(100, (hits / hitTotal) * 100)) : null;
  const hitValue =
    hitPercent != null
      ? `${hitPercent.toFixed(1)}%`
      : "—";
  const hitHint = t("homeWorkspace.widgets.redisOverview.hitHint", {
    hits: formatCount(snapshot.keyspaceHits),
    misses: formatCount(snapshot.keyspaceMisses),
  });

  const frag = snapshot.memFragmentationRatio;
  const fragValue = frag != null ? frag.toFixed(2) : "—";
  // 进度条：2.0 为满格；>1.5 告警
  const fragPercent =
    frag != null && Number.isFinite(frag)
      ? Math.max(0, Math.min(100, (frag / REDIS_FRAG_RATIO_BAR_FULL) * 100))
      : null;

  return (
    <div className="sc-redis-ov" data-loading={loading ? "1" : "0"}>
      <div className="sc-redis-ov__grid">
        <MetricCell
          label={t("homeWorkspace.widgets.redisOverview.memory")}
          value={memValue}
          hint={memHint}
          percent={memPercent}
          tone={toneFromPercent(memPercent)}
        />
        <MetricCell
          label={t("homeWorkspace.widgets.redisOverview.connections")}
          value={connValue}
          percent={connPercent}
          tone={toneFromPercent(connPercent)}
        />
        <MetricCell
          label={t("homeWorkspace.widgets.redisOverview.hitRate")}
          value={hitValue}
          hint={hitHint}
          percent={hitPercent}
          tone={
            hitPercent == null
              ? "neutral"
              : hitPercent < 80
                ? "warn"
                : "ok"
          }
        />
        <MetricCell
          label={t("homeWorkspace.widgets.redisOverview.fragmentation")}
          value={fragValue}
          hint={t("homeWorkspace.widgets.redisOverview.fragmentationHint")}
          percent={fragPercent}
          tone={toneFromFragmentation(frag)}
        />
      </div>
      {error ? <div className="sc-redis-ov__banner">{error}</div> : null}
    </div>
  );
}

