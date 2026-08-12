import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../../../i18n";
import { formatBytes } from "../../../../stores/sshStatsStore";
import { useDbConnectionListStore } from "../../../../stores/dbConnectionListStore";
import { useDashboardStore } from "../../useDashboardStore";
import type { SmallComponentController, SmallComponentRenderProps } from "../types";
import {
  fetchMysqlOverviewSnapshot,
  type MysqlOverviewSnapshot,
} from "./fetchMysqlOverview";
import { MYSQL_OVERVIEW_DB_TYPES, MYSQL_OVERVIEW_REFRESH_MS } from "./layout";

type MysqlOverviewController = SmallComponentController & {
  subscribe: (listener: () => void) => () => void;
  revision: number;
};

function asMysqlController(
  controller: SmallComponentController | undefined,
): MysqlOverviewController | null {
  if (!controller) return null;
  const c = controller as MysqlOverviewController;
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

function bufferPoolUsage(snapshot: MysqlOverviewSnapshot): {
  usedLabel: string;
  percent: number | null;
} {
  const size = snapshot.innodbBufferPoolSizeBytes;
  if (
    snapshot.innodbBufferPoolBytesData != null &&
    size != null &&
    size > 0
  ) {
    return {
      usedLabel: formatBytes(snapshot.innodbBufferPoolBytesData),
      percent: clampPercent(snapshot.innodbBufferPoolBytesData, size),
    };
  }
  const pages = clampPercent(
    snapshot.innodbBufferPoolPagesData,
    snapshot.innodbBufferPoolPagesTotal,
  );
  if (
    pages != null &&
    size != null &&
    snapshot.innodbBufferPoolPagesTotal != null &&
    snapshot.innodbBufferPoolPagesTotal > 0
  ) {
    const usedPages = snapshot.innodbBufferPoolPagesData ?? 0;
    const usedBytes =
      (usedPages / snapshot.innodbBufferPoolPagesTotal) * size;
    return {
      usedLabel: formatBytes(usedBytes),
      percent: pages,
    };
  }
  return {
    usedLabel: "—",
    percent: null,
  };
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
  /** 0–100；有值时显示进度条 */
  percent?: number | null;
}) {
  const showBar = percent != null && Number.isFinite(percent);
  const width = showBar ? Math.max(0, Math.min(100, percent)) : 0;
  return (
    <div className="sc-mysql-ov__cell" data-tone={tone ?? "neutral"}>
      <div className="sc-mysql-ov__cell-label">{label}</div>
      <div className="sc-mysql-ov__cell-value">{value}</div>
      {showBar ? (
        <div className="sc-mysql-ov__bar-track" aria-hidden>
          <div
            className="sc-mysql-ov__bar-fill"
            data-tone={tone ?? "neutral"}
            style={{ width: `${width}%` }}
          />
        </div>
      ) : null}
      {hint ? <div className="sc-mysql-ov__cell-hint">{hint}</div> : null}
    </div>
  );
}

export function MysqlOverviewView({
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
  const dbConnections = useDbConnectionListStore((s) => s.connections);
  const dbLoaded = useDbConnectionListStore((s) => s.loaded);
  const refreshDbList = useDbConnectionListStore((s) => s.refresh);
  const monitor = asMysqlController(controller);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!monitor) return;
    return monitor.subscribe(() => setTick((n) => n + 1));
  }, [monitor]);

  useEffect(() => {
    if (dbLoaded) return;
    void refreshDbList();
  }, [dbLoaded, refreshDbList]);

  const connectionId = dataSourceIdProp ?? widget?.dataSourceId ?? null;
  const connection = useMemo(
    () =>
      connectionId
        ? (dbConnections.find((c) => c.id === connectionId) ?? null)
        : null,
    [connectionId, dbConnections],
  );
  const selectedDatabase =
    widget?.target?.kind === "database-schema"
      ? widget.target.database.trim()
      : "";

  const [snapshot, setSnapshot] = useState<MysqlOverviewSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    async function load() {
      if (!connection || !selectedDatabase) return;
      setLoading(true);
      setError(null);
      try {
        const next = await fetchMysqlOverviewSnapshot({
          id: connection.id,
          name: connection.name,
          db_type: connection.db_type,
          host: connection.host,
          port: connection.port,
          user: connection.user,
          password: connection.password ?? "",
          database: selectedDatabase,
          ssl: Boolean(connection.ssl),
          status: connection.status ?? "unknown",
          enabled: connection.enabled,
          has_password: connection.has_password,
        });
        if (!cancelled) {
          setSnapshot(next);
        }
      } catch (e) {
        if (!cancelled) {
          setSnapshot(null);
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    if (!connection || !selectedDatabase) {
      setSnapshot(null);
      setError(null);
      setLoading(false);
      return;
    }

    const dbType = connection.db_type.trim().toLowerCase();
    if (!(MYSQL_OVERVIEW_DB_TYPES as readonly string[]).includes(dbType)) {
      setSnapshot(null);
      setError(null);
      setLoading(false);
      return;
    }

    void load();
    timer = window.setInterval(() => {
      void load();
    }, MYSQL_OVERVIEW_REFRESH_MS);

    return () => {
      cancelled = true;
      if (timer != null) window.clearInterval(timer);
    };
  }, [connection, monitor?.revision, selectedDatabase]);

  if (!connectionId) {
    return (
      <div className="sc-mysql-ov sc-mysql-ov--empty">
        <p className="sc-mysql-ov__empty-title">
          {t("homeWorkspace.customPanel.dataSource.requiredTitle")}
        </p>
        <p className="sc-mysql-ov__empty-hint">
          {t("homeWorkspace.widgets.mysqlOverview.needConnection")}
        </p>
      </div>
    );
  }

  if (!connection) {
    return (
      <div className="sc-mysql-ov sc-mysql-ov--empty">
        <p className="sc-mysql-ov__empty-title">
          {t("homeWorkspace.widgets.mysqlOverview.notFound")}
        </p>
        <p className="sc-mysql-ov__empty-hint">
          {t("homeWorkspace.widgets.mysqlOverview.notFoundHint")}
        </p>
      </div>
    );
  }

  const dbType = connection.db_type.trim().toLowerCase();
  if (!(MYSQL_OVERVIEW_DB_TYPES as readonly string[]).includes(dbType)) {
    return (
      <div className="sc-mysql-ov sc-mysql-ov--empty">
        <p className="sc-mysql-ov__empty-title">
          {t("homeWorkspace.widgets.mysqlOverview.needMysql")}
        </p>
        <p className="sc-mysql-ov__empty-hint">
          {t("homeWorkspace.widgets.mysqlOverview.needMysqlHint")}
        </p>
      </div>
    );
  }

  if (!selectedDatabase) {
    return (
      <div className="sc-mysql-ov sc-mysql-ov--empty">
        <p className="sc-mysql-ov__empty-title">
          {t("homeWorkspace.customPanel.target.requiredTitle")}
        </p>
        <p className="sc-mysql-ov__empty-hint">
          {t("homeWorkspace.widgets.mysqlOverview.needDatabaseHint")}
        </p>
      </div>
    );
  }

  if (error && !snapshot) {
    return (
      <div className="sc-mysql-ov sc-mysql-ov--empty">
        <p className="sc-mysql-ov__empty-title">
          {t("homeWorkspace.widgets.mysqlOverview.loadFailed")}
        </p>
        <p className="sc-mysql-ov__empty-hint">{error}</p>
      </div>
    );
  }

  if (!snapshot && loading) {
    return (
      <div className="sc-mysql-ov sc-mysql-ov--empty">
        <p className="sc-mysql-ov__empty-title">
          {t("homeWorkspace.widgets.mysqlOverview.loading")}
        </p>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="sc-mysql-ov sc-mysql-ov--empty">
        <p className="sc-mysql-ov__empty-title">
          {t("homeWorkspace.widgets.mysqlOverview.emptyTitle")}
        </p>
      </div>
    );
  }

  const diskPercent = clampPercent(snapshot.diskBytes, snapshot.diskTotalBytes);
  const diskUsedLabel =
    snapshot.diskBytes != null ? formatBytes(snapshot.diskBytes) : "—";
  const diskTotalLabel =
    snapshot.diskTotalBytes != null ? formatBytes(snapshot.diskTotalBytes) : "—";
  const diskValue =
    snapshot.diskBytes != null
      ? `${diskUsedLabel} / ${diskTotalLabel}`
      : "—";
  const diskHint =
    snapshot.diskTotalBytes != null
      ? t("homeWorkspace.widgets.mysqlOverview.diskHint", {
          db: snapshot.database,
        })
      : t("homeWorkspace.widgets.mysqlOverview.diskNeedSsh", {
          db: snapshot.database,
        });

  const connPercent = clampPercent(
    snapshot.threadsConnected,
    snapshot.maxConnections,
  );
  const connValue =
    snapshot.threadsConnected != null && snapshot.maxConnections != null
      ? `${formatCount(snapshot.threadsConnected)} / ${formatCount(snapshot.maxConnections)}`
      : formatCount(snapshot.maxConnections);

  const pool = bufferPoolUsage(snapshot);
  const poolSizeLabel =
    snapshot.innodbBufferPoolSizeBytes != null
      ? formatBytes(snapshot.innodbBufferPoolSizeBytes)
      : "—";
  const poolValue =
    pool.percent != null
      ? `${pool.usedLabel} / ${poolSizeLabel}`
      : poolSizeLabel;

  const cachePercent = clampPercent(
    snapshot.threadsCached,
    snapshot.threadCacheSize,
  );
  const cacheValue =
    snapshot.threadsCached != null && snapshot.threadCacheSize != null
      ? `${formatCount(snapshot.threadsCached)} / ${formatCount(snapshot.threadCacheSize)}`
      : formatCount(snapshot.threadCacheSize);

  return (
    <div className="sc-mysql-ov" data-loading={loading ? "1" : "0"}>
      <div className="sc-mysql-ov__grid">
        <MetricCell
          label={t("homeWorkspace.widgets.mysqlOverview.disk")}
          value={diskValue}
          hint={diskHint}
          percent={diskPercent}
          tone={toneFromPercent(diskPercent)}
        />
        <MetricCell
          label={t("homeWorkspace.widgets.mysqlOverview.bufferPool")}
          value={poolValue}
          hint={t("homeWorkspace.widgets.mysqlOverview.bufferPoolHint", {
            instances: formatCount(snapshot.innodbBufferPoolInstances),
          })}
          percent={pool.percent}
          tone={toneFromPercent(pool.percent)}
        />
        <MetricCell
          label={t("homeWorkspace.widgets.mysqlOverview.connections")}
          value={connValue}
          hint={
            snapshot.maxUsedConnections != null
              ? t("homeWorkspace.widgets.mysqlOverview.connectionsPeak", {
                  value: formatCount(snapshot.maxUsedConnections),
                })
              : undefined
          }
          percent={connPercent}
          tone={toneFromPercent(connPercent)}
        />
        <MetricCell
          label={t("homeWorkspace.widgets.mysqlOverview.threadCache")}
          value={cacheValue}
          percent={cachePercent}
          tone="neutral"
        />
      </div>
      {error ? <div className="sc-mysql-ov__banner">{error}</div> : null}
    </div>
  );
}

