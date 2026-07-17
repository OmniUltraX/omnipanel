import { useCallback, useMemo, useState } from "react";
import { commands } from "../../ipc/bindings";
import { useI18n } from "../../i18n";
import { useSshStatsStore } from "../../stores/sshStatsStore";
import { resolveHostMonitorStatus } from "./hostMonitorStatus";
import { ResourceMonitorHostCard } from "./ResourceMonitorHostCard";
import { useActiveMonitoringHosts } from "./useActiveMonitoringHosts";

function formatClock(ts: number | null): string {
  if (ts == null) return "--:--:--";
  const d = new Date(ts);
  return [
    String(d.getHours()).padStart(2, "0"),
    String(d.getMinutes()).padStart(2, "0"),
    String(d.getSeconds()).padStart(2, "0"),
  ].join(":");
}

/** 首页「资源监控」tab：对齐设计稿的主机卡片平铺视图 */
export function ResourceMonitorBoard() {
  const { t } = useI18n();
  const hosts = useActiveMonitoringHosts();
  const [refreshing, setRefreshing] = useState(false);

  const counts = useMemo(() => {
    let ok = 0;
    let warn = 0;
    let danger = 0;
    for (const h of hosts) {
      const s = resolveHostMonitorStatus(h.stats);
      if (s === "danger") danger += 1;
      else if (s === "warn") warn += 1;
      else ok += 1;
    }
    return { ok, warn, danger };
  }, [hosts]);

  const latestUpdatedAt = useMemo(() => {
    let max: number | null = null;
    for (const h of hosts) {
      if (h.updatedAt != null && (max == null || h.updatedAt > max)) {
        max = h.updatedAt;
      }
    }
    return max;
  }, [hosts]);

  const onRefresh = useCallback(async () => {
    if (hosts.length === 0 || refreshing) return;
    setRefreshing(true);
    try {
      await Promise.all(
        hosts.map(async (host) => {
          try {
            const res = await commands.sshPoolFetchStats(host.resourceId);
            if (res.status === "ok") {
              useSshStatsStore.getState().setStats([res.data]);
            }
          } catch {
            // ignore per-host failure
          }
        }),
      );
    } finally {
      window.setTimeout(() => setRefreshing(false), 400);
    }
  }, [hosts, refreshing]);

  return (
    <div className="hm-view">
      <div className="hm-toolbar">
        <div className="hm-summary">
          <span className="hm-chip">
            <strong>{hosts.length}</strong> {t("dashboard.resourceMonitor.hostCount")}
          </span>
          <span className="hm-chip">
            <span className="hm-chip-dot" style={{ background: "var(--success)" }} />
            <strong>{counts.ok}</strong> {t("dashboard.resourceMonitor.statusOk")}
          </span>
          <span className="hm-chip">
            <span className="hm-chip-dot" style={{ background: "var(--warn)" }} />
            <strong>{counts.warn}</strong> {t("dashboard.resourceMonitor.statusWarn")}
          </span>
          <span className="hm-chip">
            <span className="hm-chip-dot" style={{ background: "var(--danger)" }} />
            <strong>{counts.danger}</strong> {t("dashboard.resourceMonitor.statusDanger")}
          </span>
        </div>
        <span className="hm-toolbar-spacer" />
        <span className="hm-updated">
          {t("dashboard.resourceMonitor.updatedAt", {
            time: formatClock(latestUpdatedAt),
          })}
        </span>
        <button
          type="button"
          className={`hm-refresh${refreshing ? " spinning" : ""}`}
          onClick={() => void onRefresh()}
          disabled={refreshing || hosts.length === 0}
          title={t("dashboard.resourceMonitor.refresh")}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M23 4v6h-6M1 20v-6h6" />
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
          </svg>
          {t("dashboard.resourceMonitor.refresh")}
        </button>
      </div>

      {hosts.length === 0 ? (
        <div className="hm-empty">
          <h3>{t("dashboard.resourceMonitor.emptyTitle")}</h3>
          <p>{t("dashboard.resourceMonitor.emptyHint")}</p>
        </div>
      ) : (
        <div className="hm-scroll">
          <div className="hm-grid">
            {hosts.map((host) => (
              <ResourceMonitorHostCard key={host.resourceId} host={host} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
