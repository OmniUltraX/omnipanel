import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../../../i18n";
import { Button } from "../../../../components/ui/primitives/Button";
import type { ServerEntry } from "../serverConnection";
import { createOnePanelClient } from "../../../../lib/onepanel";
import { createBtPanelClient } from "../../../../lib/btpanel";
import type { OnePanelDashboardBase } from "../../../../lib/onepanel/types";

interface Props {
  server: ServerEntry;
}

type ChartRange = "1h" | "6h" | "24h" | "7d";

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatGb(bytes: number): string {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function pctBadgeClass(pct: number): string {
  if (pct >= 85) return "badge badge-warn";
  if (pct >= 60) return "badge badge-accent";
  return "badge badge-success";
}

function chartRangeMs(range: ChartRange): number {
  switch (range) {
    case "1h":
      return 60 * 60 * 1000;
    case "6h":
      return 6 * 60 * 60 * 1000;
    case "7d":
      return 7 * 24 * 60 * 60 * 1000;
    default:
      return 24 * 60 * 60 * 1000;
  }
}

function barFillClass(pct: number): string {
  if (pct >= 85) return "warn";
  if (pct >= 60) return "accent";
  return "success";
}

export function ServerMonitorTab({ server }: Props) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [chartRange, setChartRange] = useState<ChartRange>("24h");
  const [dashboard, setDashboard] = useState<OnePanelDashboardBase | null>(null);
  const [chartValues, setChartValues] = useState<number[]>([]);

  const load = async (range: ChartRange = chartRange) => {
    setLoading(true);
    setError(null);
    try {
      if (server.serviceType === "1panel") {
        const op = createOnePanelClient(server.address, server.key);
        const base = await op.getDashboardBase();
        setDashboard(base);

        const end = new Date();
        const start = new Date(end.getTime() - chartRangeMs(range));
        try {
          const history = await op.searchMonitorHistory({
            param: "cpu",
            startTime: start.toISOString(),
            endTime: end.toISOString(),
          });
          const values = (history.value ?? [])
            .map((v) => (typeof v === "number" ? v : Number(v)))
            .filter((v) => Number.isFinite(v));
          setChartValues(values.length > 0 ? values : []);
        } catch {
          setChartValues([]);
        }
      } else {
        const bt = createBtPanelClient(server.address, server.key);
        const [total, network, disks] = await Promise.all([
          bt.getSystemTotal(),
          bt.getNetwork(),
          bt.getDiskInfo(),
        ]);
        const memPct = total.memTotal ? (total.memRealUsed ?? 0) / total.memTotal * 100 : 0;
        const cpuPct = network.cpu?.[0] ?? total.cpuRealUsed ?? 0;
        const rootDisk = disks[0];
        const diskUsed = rootDisk?.size?.[0] ? Number.parseFloat(String(rootDisk.size[0])) : 0;
        const diskTotal = rootDisk?.size?.[1] ? Number.parseFloat(String(rootDisk.size[1])) : 0;
        setDashboard({
          hostname: total.system,
          os: total.system,
          platformVersion: total.version,
          cpuCores: total.cpuNum,
          currentInfo: {
            cpuUsedPercent: cpuPct,
            memoryTotal: (total.memTotal ?? 0) * 1024 * 1024,
            memoryUsed: (total.memRealUsed ?? 0) * 1024 * 1024,
            memoryAvailable: ((total.memTotal ?? 0) - (total.memRealUsed ?? 0)) * 1024 * 1024,
            memoryUsedPercent: memPct,
            load1: network.load?.one,
            load5: network.load?.five,
            load15: network.load?.fifteen,
            diskData: rootDisk
              ? [{ path: rootDisk.path, total: diskTotal, used: diskUsed, usedPercent: diskTotal ? (diskUsed / diskTotal) * 100 : 0 }]
              : [],
          },
        });
        setChartValues([]);
      }
    } catch (e) {
      setError(String(e));
      setDashboard(null);
      setChartValues([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(chartRange);
  }, [server.id, chartRange]);

  const current = dashboard?.currentInfo;
  const primaryDisk = current?.diskData?.[0];
  const cpuPct = current?.cpuUsedPercent ?? 0;
  const memPct = current?.memoryUsedPercent ?? 0;
  const diskPct = primaryDisk?.usedPercent ?? 0;

  const chartMax = useMemo(
    () => Math.max(...chartValues, 1),
    [chartValues],
  );

  const chartRanges: ChartRange[] = ["1h", "6h", "24h", "7d"];

  return (
    <div className="server-panel-tab server-panel-tab--flush">
      <div className="server-panel-tab-toolbar server-panel-tab-toolbar--compact">
        <span className="server-header">
          <strong>{server.name}</strong>
          <span>{server.address}</span>
        </span>
        <Button variant="ghost" size="sm" disabled={loading} onClick={() => void load()}>
          {loading ? t("server.refreshing") : t("server.refresh")}
        </Button>
      </div>

      {error && <div className="server-apps-error">{error}</div>}

      <div className="monitor-grid">
        <div className="monitor-card">
          <div className="monitor-label">
            <span>{t("server.monitor.cpu")}</span>
            <span className={pctBadgeClass(cpuPct)}>
              {cpuPct >= 85 ? t("server.monitor.high") : t("server.monitor.normal")}
            </span>
          </div>
          <div className="monitor-value text-accent">{cpuPct.toFixed(1)}%</div>
          <div className="monitor-bar">
            <div
              className={`monitor-bar-fill ${barFillClass(cpuPct)}`}
              style={{ width: `${Math.min(100, cpuPct)}%` }}
            />
          </div>
          <div className="monitor-detail">
            {dashboard?.cpuCores ?? 0} {t("server.monitor.cores")}
            {dashboard?.cpuModelName ? ` · ${dashboard.cpuModelName}` : ""}
          </div>
        </div>

        <div className="monitor-card">
          <div className="monitor-label">
            <span>{t("server.monitor.memory")}</span>
            <span className={pctBadgeClass(memPct)}>{memPct.toFixed(0)}%</span>
          </div>
          <div className="monitor-value text-warn">{formatGb(current?.memoryUsed ?? 0)}</div>
          <div className="monitor-bar">
            <div
              className={`monitor-bar-fill ${barFillClass(memPct)}`}
              style={{ width: `${Math.min(100, memPct)}%` }}
            />
          </div>
          <div className="monitor-detail">
            {formatGb(current?.memoryTotal ?? 0)} {t("server.monitor.total")}
            {current?.memoryAvailable != null
              ? ` · ${formatGb(current.memoryAvailable)} ${t("server.monitor.available")}`
              : ""}
          </div>
        </div>

        <div className="monitor-card">
          <div className="monitor-label">
            <span>{t("server.monitor.disk")}</span>
            <span className={pctBadgeClass(diskPct)}>{diskPct.toFixed(0)}%</span>
          </div>
          <div className="monitor-value">{formatGb(primaryDisk?.used ?? 0)}</div>
          <div className="monitor-bar">
            <div
              className={`monitor-bar-fill ${barFillClass(diskPct)}`}
              style={{ width: `${Math.min(100, diskPct)}%` }}
            />
          </div>
          <div className="monitor-detail">
            {primaryDisk?.path ? `${primaryDisk.path} · ` : ""}
            {formatGb(primaryDisk?.total ?? 0)} {t("server.monitor.total")}
            {primaryDisk?.free != null
              ? ` · ${formatGb(primaryDisk.free)} ${t("server.monitor.available")}`
              : ""}
          </div>
        </div>

        <div className="monitor-card">
          <div className="monitor-label">
            <span>{t("server.monitor.network")}</span>
            <span className="badge badge-accent">{t("server.monitor.active")}</span>
          </div>
          <div className="monitor-value text-success">
            ↑ {formatBytes(current?.netBytesSent ?? 0)}
          </div>
          <div className="monitor-bar">
            <div className="monitor-bar-fill accent" style={{ width: "24%" }} />
          </div>
          <div className="monitor-detail">
            ↓ {formatBytes(current?.netBytesRecv ?? 0)}
          </div>
        </div>
      </div>

      <div className="chart-area">
        <div className="chart-header">
          <h3>{t("server.monitor.cpuChart")}</h3>
          <div className="chart-tabs">
            {chartRanges.map((range) => (
              <button
                key={range}
                type="button"
                className={`chart-tab${chartRange === range ? " active" : ""}`}
                onClick={() => setChartRange(range)}
              >
                {range}
              </button>
            ))}
          </div>
        </div>
        <div className="chart-body">
          {chartValues.length > 0 ? (
            chartValues.map((value, idx) => (
              <div
                key={idx}
                className="chart-bar"
                style={{ height: `${Math.max(4, (value / chartMax) * 100)}%` }}
                title={`${value.toFixed(1)}%`}
              />
            ))
          ) : (
            <div className="server-apps-empty">{t("server.monitor.chartEmpty")}</div>
          )}
        </div>
      </div>

      <div className="info-grid">
        <div className="info-card">
          <h4>{t("server.monitor.systemInfo")}</h4>
          <div className="info-row">
            <span className="label">{t("server.monitor.hostname")}</span>
            <span className="value">{dashboard?.hostname ?? "—"}</span>
          </div>
          <div className="info-row">
            <span className="label">{t("server.monitor.os")}</span>
            <span className="value">{dashboard?.os ?? "—"}</span>
          </div>
          <div className="info-row">
            <span className="label">{t("server.monitor.kernel")}</span>
            <span className="value">{dashboard?.kernelVersion ?? "—"}</span>
          </div>
          <div className="info-row">
            <span className="label">{t("server.monitor.uptime")}</span>
            <span className="value">{current?.timeSinceUptime ?? "—"}</span>
          </div>
          <div className="info-row">
            <span className="label">{t("server.monitor.load")}</span>
            <span className="value">
              {current?.load1 != null
                ? `${current.load1.toFixed(2)}, ${current.load5?.toFixed(2) ?? "—"}, ${current.load15?.toFixed(2) ?? "—"}`
                : "—"}
            </span>
          </div>
        </div>

        <div className="info-card">
          <h4>{t("server.monitor.networkInfo")}</h4>
          <div className="info-row">
            <span className="label">{t("server.monitor.ip")}</span>
            <span className="value">{dashboard?.ipV4Addr ?? "—"}</span>
          </div>
          <div className="info-row">
            <span className="label">{t("server.monitor.platform")}</span>
            <span className="value">{dashboard?.platform ?? "—"}</span>
          </div>
          <div className="info-row">
            <span className="label">{t("server.monitor.cpuModel")}</span>
            <span className="value">{dashboard?.cpuModelName ?? "—"}</span>
          </div>
          <div className="info-row">
            <span className="label">{t("server.monitor.cpuCores")}</span>
            <span className="value">{dashboard?.cpuCores ?? "—"}</span>
          </div>
        </div>
      </div>

      {!loading && !dashboard && !error && (
        <div className="server-apps-empty">{t("server.monitor.empty")}</div>
      )}
    </div>
  );
}
