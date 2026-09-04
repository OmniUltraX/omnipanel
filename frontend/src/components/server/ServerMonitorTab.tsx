import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/i18n";
import { useModuleSuspended } from "@/lib/moduleVisibility";
import { Button } from "@/components/ui/primitives/Button";
import { IconRefresh } from "@/components/ui/Icons";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/primitives/dialog";
import type { ServerEntry } from "@/modules/server/panel/serverConnection";
import { findSshForPanel, parseSshConfig } from "@/modules/server/panel/serverConnection";
import { dashboardToHostStats } from "./panelMonitorStats";
import { createOnePanelClient } from "@/lib/onepanel";
import { createBtPanelClient, isBtPanelAuthFailureMessage, parseBtDiskUsageList } from "@/lib/btpanel";
import type { OnePanelDashboardBase } from "@/lib/onepanel/types";
import { useConnectionStore } from "@/stores/connectionStore";
import { commands } from "@/ipc/bindings";
import type { HostSystemStats } from "@/stores/sshStatsStore";
import { MonMetricCards } from "@/modules/server/ssh/components/monitoring/MonMetricCards";
import { computeByteRate } from "@/modules/server/ssh/components/monitoring/monitoringUtils";
import { useMonitorSparklines } from "@/modules/server/ssh/components/monitoring/useMonitorSparklines";
import { isBtPanelService, isOnePanelService } from "@/modules/server/panel/panelPlugin";

interface Props {
  server: ServerEntry;
  /** 当前 Monitor 区域处于激活且模块可见时为 true */
  active?: boolean;
}

const DASHBOARD_POLL_MS = 2000;

function formatLoadTriple(load1?: number, load5?: number, load15?: number): string {
  if (load1 == null) return "—";
  return `${load1.toFixed(2)}, ${load5?.toFixed(2) ?? "—"}, ${load15?.toFixed(2) ?? "—"}`;
}

function isLikelyIp(value: string): boolean {
  return value.length > 0 && value.length <= 45 && /^[\d.a-fA-F:]+$/.test(value);
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="info-row">
      <span className="label">{label}</span>
      <span className="value">{value}</span>
    </div>
  );
}

export function ServerMonitorTab({ server, active = true }: Props) {
  const { t } = useI18n();
  const moduleSuspended = useModuleSuspended();
  const connections = useConnectionStore((s) => s.connections);
  const pollingActive = active && !moduleSuspended;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dashboard, setDashboard] = useState<OnePanelDashboardBase | null>(null);
  const [publicIp, setPublicIp] = useState<string | null>(null);
  const [publicIpLoading, setPublicIpLoading] = useState(false);
  const [systemDetailOpen, setSystemDetailOpen] = useState(false);
  const prevStatsRef = useRef<HostSystemStats | null>(null);

  const sshConnection = useMemo(
    () => findSshForPanel(connections, server.id),
    [connections, server.id],
  );
  const sshConfig = useMemo(
    () => (sshConnection ? parseSshConfig(sshConnection) : null),
    [sshConnection],
  );

  const stats = useMemo(
    () => (dashboard ? dashboardToHostStats(server.id, dashboard) : null),
    [dashboard, server.id],
  );
  const sparklines = useMonitorSparklines(stats);

  useEffect(() => {
    if (stats) {
      prevStatsRef.current = stats;
    }
  }, [stats]);

  const prevStats = prevStatsRef.current;
  const diskReadRate =
    stats && prevStats && prevStats !== stats
      ? computeByteRate(prevStats, stats, (s) => s.disk?.readBytes ?? null)
      : null;
  const diskWriteRate =
    stats && prevStats && prevStats !== stats
      ? computeByteRate(prevStats, stats, (s) => s.disk?.writeBytes ?? null)
      : null;

  const refreshDashboardCurrent = useCallback(
    async (options?: { silent?: boolean }): Promise<"ok" | "auth" | "error"> => {
      try {
        if (isOnePanelService(server.serviceType)) {
          const op = createOnePanelClient(server.address, server.key, server.id, server.panelUser);
          const current = await op.getDashboardCurrent();
          setDashboard((prev) =>
            prev ? { ...prev, currentInfo: current } : { currentInfo: current },
          );
        } else {
          const bt = createBtPanelClient(server.address, server.key, server.id);
          // 串行：避免每 2s 并发 3 路把宝塔验证失败计数打满
          const total = await bt.getSystemTotal();
          const network = await bt.getNetwork();
          const disks = await bt.getDiskInfo();
          const memPct = total.memTotal ? ((total.memRealUsed ?? 0) / total.memTotal) * 100 : 0;
          const cpuPct = network.cpu?.[0] ?? total.cpuRealUsed ?? 0;
          const diskUsages = parseBtDiskUsageList(Array.isArray(disks) ? disks : []);
          setDashboard((prev) => ({
            ...(prev ?? {
              hostname: total.system,
              os: total.system,
              platformVersion: total.version,
              cpuCores: total.cpuNum,
            }),
            currentInfo: {
              cpuUsedPercent: cpuPct,
              memoryTotal: (total.memTotal ?? 0) * 1024 * 1024,
              memoryUsed: (total.memRealUsed ?? 0) * 1024 * 1024,
              memoryAvailable: ((total.memTotal ?? 0) - (total.memRealUsed ?? 0)) * 1024 * 1024,
              memoryUsedPercent: memPct,
              load1: network.load?.one,
              load5: network.load?.five,
              load15: network.load?.fifteen,
              diskData: diskUsages.map((d) => ({
                path: d.path,
                total: d.total,
                used: d.used,
                free: d.free,
                usedPercent: d.usedPercent,
              })),
            },
          }));
        }
        if (!options?.silent) {
          setError(null);
        }
        return "ok";
      } catch (e) {
        const msg = String(e);
        const auth =
          isBtPanelService(server.serviceType) && isBtPanelAuthFailureMessage(msg);
        // 鉴权/封禁始终展示，避免静默轮询把状态藏起来
        if (!options?.silent || auth) {
          setError(msg);
        }
        if (auth) {
          return "auth";
        }
        return "error";
      }
    },
    [server.address, server.id, server.key, server.panelUser, server.serviceType],
  );

  const load = useCallback(async () => {
      setLoading(true);
      setError(null);
      try {
        if (isOnePanelService(server.serviceType)) {
          const op = createOnePanelClient(server.address, server.key, server.id, server.panelUser);
          const base = await op.getDashboardBase().catch(() => op.getOsInfo());
          const current = await op.getDashboardCurrent().catch(() => base.currentInfo);
          setDashboard({ ...base, currentInfo: current ?? base.currentInfo });
        } else {
          await refreshDashboardCurrent();
        }
      } catch (e) {
        setError(String(e));
        setDashboard(null);
      } finally {
        setLoading(false);
      }
    },
    [refreshDashboardCurrent, server.address, server.key, server.panelUser, server.serviceType],
  );

  useEffect(() => {
    void load();
  }, [load, server.id]);

  useEffect(() => {
    if (!pollingActive) {
      return;
    }
    let stopped = false;
    let timer: number | null = null;

    const tick = async (silent: boolean) => {
      if (stopped) return;
      const result = await refreshDashboardCurrent({ silent });
      if (stopped) return;
      // 鉴权/封禁后停轮询，避免每 2s 继续打宝塔验证计数
      if (result === "auth") {
        stopped = true;
        if (timer != null) window.clearInterval(timer);
        return;
      }
    };

    void tick(false);
    timer = window.setInterval(() => {
      void tick(true);
    }, DASHBOARD_POLL_MS);
    return () => {
      stopped = true;
      if (timer != null) window.clearInterval(timer);
    };
  }, [pollingActive, refreshDashboardCurrent, server.id]);

  useEffect(() => {
    if (sshConfig?.publicIp) {
      setPublicIp(sshConfig.publicIp);
      return;
    }
    if (!sshConnection) {
      setPublicIp(null);
      return;
    }
    let cancelled = false;
    setPublicIpLoading(true);
    void commands
      .sshPoolExecCommand(sshConnection.id, "curl -s --connect-timeout 5 ip.sb", null)
      .then((res) => {
        if (cancelled) return;
        if (res.status !== "ok") {
          setPublicIp(null);
          return;
        }
        const ip = res.data.stdout.trim();
        setPublicIp(isLikelyIp(ip) ? ip : null);
      })
      .catch(() => {
        if (!cancelled) {
          setPublicIp(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setPublicIpLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sshConnection, sshConfig?.publicIp]);

  const current = dashboard?.currentInfo;
  const loadTriple = formatLoadTriple(current?.load1, current?.load5, current?.load15);
  const privateIp = dashboard?.ipV4Addr ?? sshConfig?.host ?? "—";
  const publicIpLabel = publicIpLoading
    ? t("server.monitor.publicIpLoading")
    : publicIp ?? t("server.monitor.publicIpUnavailable");

  return (
    <div className="server-panel-tab server-panel-tab--flush">
      <div className="server-panel-tab-toolbar server-panel-tab-toolbar--compact">
        <span className="server-header">
          <strong>{server.name}</strong>
          <span>{server.address}</span>
        </span>
        <Button
          type="button"
          variant="icon"
          size="icon-xs"
          disabled={loading}
          title={loading ? t("server.refreshing") : t("server.refresh")}
          aria-label={loading ? t("server.refreshing") : t("server.refresh")}
          onClick={() => void load()}
        >
          <IconRefresh size={14} />
        </Button>
      </div>

      {error && <div className="server-apps-error">{error}</div>}

      <div className="monitor-overview-row">
        <div className="server-panel-monitor-wrap">
          <h4 className="monitor-realtime-card__title">{t("server.monitor.realtimeMonitor")}</h4>
          {stats ? (
            <div className="server-panel-monitor-dashboard">
              <MonMetricCards
                compact
                stats={stats}
                sparklines={sparklines}
                diskReadRate={diskReadRate}
                diskWriteRate={diskWriteRate}
              />
            </div>
          ) : (
            <div className="server-apps-empty">{t("server.monitor.empty")}</div>
          )}
        </div>

        <div className="monitor-system-card">
          <div className="monitor-system-card__header">
            <h4 className="monitor-system-card__title">{t("server.monitor.systemInfo")}</h4>
            <Button
              variant="ghost"
              size="icon-sm"
              className="monitor-system-card__detail-btn"
              title={t("server.monitor.viewDetails")}
              aria-label={t("server.monitor.viewDetails")}
              onClick={() => setSystemDetailOpen(true)}
            >
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                width="14"
                height="14"
                aria-hidden
              >
                <circle cx="8" cy="8" r="6.25" />
                <path d="M8 7.2V11" strokeLinecap="round" />
                <circle cx="8" cy="5.1" r="0.75" fill="currentColor" stroke="none" />
              </svg>
            </Button>
          </div>
          <InfoRow label={t("server.monitor.os")} value={dashboard?.os ?? "—"} />
          <InfoRow label={t("server.monitor.kernel")} value={dashboard?.kernelVersion ?? "—"} />
          <InfoRow label={t("server.monitor.privateIp")} value={privateIp} />
          <InfoRow label={t("server.monitor.publicIp")} value={publicIpLabel} />
        </div>
      </div>

      <Dialog open={systemDetailOpen} onOpenChange={setSystemDetailOpen}>
        <DialogContent className="monitor-system-detail-dialog sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("server.monitor.systemDetail")}</DialogTitle>
          </DialogHeader>
          <InfoRow label={t("server.monitor.hostname")} value={dashboard?.hostname ?? "—"} />
          <InfoRow label={t("server.monitor.os")} value={dashboard?.os ?? "—"} />
          <InfoRow label={t("server.monitor.kernel")} value={dashboard?.kernelVersion ?? "—"} />
          <InfoRow label={t("server.monitor.uptime")} value={current?.timeSinceUptime ?? "—"} />
          <InfoRow label={t("server.monitor.platform")} value={dashboard?.platform ?? "—"} />
          <InfoRow label={t("server.monitor.cpuModel")} value={dashboard?.cpuModelName ?? "—"} />
          <InfoRow
            label={t("server.monitor.cpuCores")}
            value={dashboard?.cpuCores != null ? String(dashboard.cpuCores) : "—"}
          />
          <InfoRow label={t("server.monitor.load")} value={loadTriple} />
          <InfoRow label={t("server.monitor.privateIp")} value={privateIp} />
          <InfoRow label={t("server.monitor.publicIp")} value={publicIpLabel} />
        </DialogContent>
      </Dialog>

      {!loading && !dashboard && !error && (
        <div className="server-apps-empty">{t("server.monitor.empty")}</div>
      )}
    </div>
  );
}
