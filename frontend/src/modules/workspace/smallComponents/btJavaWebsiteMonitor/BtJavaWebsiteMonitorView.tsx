import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../../../i18n";
import type { BtJavaProjectLoadInfo } from "../../../../lib/btpanel";
import { useConnectionStore } from "../../../../stores/connectionStore";
import { parsePanelConfig } from "../../../server/panel/serverConnection";
import { useDashboardStore } from "../../useDashboardStore";
import type { SmallComponentController, SmallComponentRenderProps } from "../types";
import {
  clampPercent,
  formatDockerBytes,
} from "../dockerMonitorShared/metrics";
import { fetchBtJavaWebsiteLoad } from "./fetchLoad";
import { BT_JAVA_WEBSITE_MONITOR_REFRESH_MS } from "./layout";
import "./BtJavaWebsiteMonitorView.css";

type MonitorController = SmallComponentController & {
  subscribe: (listener: () => void) => () => void;
  revision: number;
};

type Tone = "ok" | "warn" | "danger" | "neutral";

function asMonitorController(
  controller: SmallComponentController | undefined,
): MonitorController | null {
  if (!controller) return null;
  const c = controller as MonitorController;
  if (typeof c.subscribe !== "function") return null;
  return c;
}

function formatRunningTime(sec: number | null | undefined): string | null {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return null;
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** 环/格内短标签：2.15 GB → 2.2G */
function formatCompactBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return "—";
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb >= 10 ? Math.round(gb) : gb.toFixed(1)}G`;
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb >= 100 ? Math.round(mb) : mb.toFixed(0)}M`;
  const kb = bytes / 1024;
  if (kb >= 1) return `${Math.round(kb)}K`;
  return `${Math.round(bytes)}B`;
}

function softBarPercent(value: number, softMax: number): number {
  if (!Number.isFinite(value) || value < 0 || softMax <= 0) return 0;
  return Math.min(100, (value / softMax) * 100);
}

function toneFromPercent(pct: number, danger = false): Tone {
  if (danger || pct >= 90) return "danger";
  if (pct >= 70) return "warn";
  if (pct > 0) return "ok";
  return "neutral";
}

function MetricCell({
  label,
  value,
  percent,
  tone,
  title,
}: {
  label: string;
  value: string;
  percent: number;
  tone: Tone;
  title?: string;
}) {
  const width = Math.max(0, Math.min(100, percent));
  return (
    <div className="sc-bt-java-mon__cell" data-tone={tone} title={title}>
      <div className="sc-bt-java-mon__cell-label">{label}</div>
      <div className="sc-bt-java-mon__cell-value">{value}</div>
      <div className="sc-bt-java-mon__track" aria-hidden>
        <div
          className="sc-bt-java-mon__fill"
          data-tone={tone}
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  );
}

function EmptyShell({
  title,
  hint,
}: {
  title: string;
  hint?: string;
}) {
  return (
    <div className="sc-bt-java-mon sc-bt-java-mon--empty">
      <p className="sc-bt-java-mon__empty-title">{title}</p>
      {hint ? <p className="sc-bt-java-mon__empty-hint">{hint}</p> : null}
    </div>
  );
}

export function BtJavaWebsiteMonitorView({
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
  const connections = useConnectionStore((s) => s.connections);
  const monitor = asMonitorController(controller);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!monitor) return;
    return monitor.subscribe(() => setTick((n) => n + 1));
  }, [monitor]);

  const connectionId = dataSourceIdProp ?? widget?.dataSourceId ?? null;
  const projectName =
    widget?.target?.kind === "bt-java-project"
      ? widget.target.projectName
      : null;

  const connection = useMemo(
    () =>
      connectionId
        ? (connections.find((c) => c.id === connectionId && c.kind === "panel") ??
          null)
        : null,
    [connectionId, connections],
  );

  const isBt = connection
    ? parsePanelConfig(connection).serviceType === "bt"
    : false;

  const [loadInfo, setLoadInfo] = useState<BtJavaProjectLoadInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    async function load() {
      if (!connection || !projectName || !isBt) return;
      setLoading(true);
      try {
        const next = await fetchBtJavaWebsiteLoad(connection, projectName);
        if (!cancelled) {
          setLoadInfo(next);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setLoadInfo(null);
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    if (!connectionId || !connection || !isBt || !projectName) {
      setLoadInfo(null);
      setError(null);
      setLoading(false);
      return;
    }

    void load();
    timer = window.setInterval(() => {
      void load();
    }, BT_JAVA_WEBSITE_MONITOR_REFRESH_MS);

    return () => {
      cancelled = true;
      if (timer != null) window.clearInterval(timer);
    };
  }, [connection, connectionId, isBt, projectName, monitor?.revision]);

  if (!connectionId) {
    return (
      <EmptyShell
        title={t("homeWorkspace.customPanel.dataSource.requiredTitle")}
        hint={t("homeWorkspace.widgets.btJavaWebsiteMonitor.needConnection")}
      />
    );
  }

  if (!connection) {
    return (
      <EmptyShell
        title={t("homeWorkspace.widgets.btJavaWebsiteMonitor.notFound")}
        hint={t("homeWorkspace.widgets.btJavaWebsiteMonitor.notFoundHint")}
      />
    );
  }

  if (!isBt) {
    return (
      <EmptyShell
        title={t("homeWorkspace.widgets.btJavaWebsiteMonitor.needBtPanel")}
        hint={t("homeWorkspace.widgets.btJavaWebsiteMonitor.needBtPanelHint")}
      />
    );
  }

  if (!projectName) {
    return (
      <EmptyShell
        title={t("homeWorkspace.customPanel.target.requiredTitle")}
        hint={t("homeWorkspace.widgets.btJavaWebsiteMonitor.needTarget")}
      />
    );
  }

  const cpu = clampPercent(loadInfo?.cpuPercent);
  const memoryPct = clampPercent(loadInfo?.memoryPercent);
  const processOverXmx =
    loadInfo?.memoryUsedBytes != null &&
    loadInfo.heapMaxBytes != null &&
    loadInfo.heapMaxBytes > 0 &&
    loadInfo.memoryUsedBytes > loadInfo.heapMaxBytes;
  const hasMetrics =
    (loadInfo?.cpuPercent != null && Number.isFinite(loadInfo.cpuPercent)) ||
    (loadInfo?.memoryPercent != null && Number.isFinite(loadInfo.memoryPercent)) ||
    (loadInfo?.memoryUsedBytes != null && loadInfo.memoryUsedBytes > 0);

  const threads = loadInfo?.threads ?? 0;
  const connects = loadInfo?.connects ?? 0;
  const thrPct = softBarPercent(threads, 400);
  const connPct = softBarPercent(connects, 200);
  const uptimeLabel = formatRunningTime(loadInfo?.runningTimeSec);

  const memValue = formatCompactBytes(loadInfo?.memoryUsedBytes);
  const memTip = [
    processOverXmx
      ? t("homeWorkspace.widgets.btJavaWebsiteMonitor.memOverXmxHint")
      : null,
    loadInfo?.memoryUsedBytes != null
      ? `${formatDockerBytes(loadInfo.memoryUsedBytes)}${
          loadInfo.heapMaxBytes != null
            ? ` / Xmx ${formatDockerBytes(loadInfo.heapMaxBytes)}`
            : ""
        }`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const cpuValue = cpu < 10 ? `${cpu.toFixed(1)}%` : `${Math.round(cpu)}%`;
  const jarTip = loadInfo?.jarName ?? undefined;

  return (
    <div className="sc-bt-java-mon" title={jarTip}>
      <div className="sc-bt-java-mon__status">
        <span
          className={`sc-bt-java-mon__pill ${
            error ? "is-err" : hasMetrics ? "is-on" : "is-off"
          }`}
        >
          {error
            ? t("homeWorkspace.widgets.btJavaWebsiteMonitor.loadFailed")
            : hasMetrics
              ? t("homeWorkspace.widgets.btJavaWebsiteMonitor.statusRunning")
              : loading
                ? t("homeWorkspace.widgets.btJavaWebsiteMonitor.loading")
                : t("homeWorkspace.widgets.btJavaWebsiteMonitor.statusIdle")}
        </span>
      </div>

      {error ? (
        <p className="sc-bt-java-mon__error" title={error}>
          {error}
        </p>
      ) : hasMetrics ? (
        <div className="sc-bt-java-mon__grid">
          <MetricCell
            label={t("homeWorkspace.widgets.btJavaWebsiteMonitor.cpuShort")}
            value={cpuValue}
            percent={cpu}
            tone={toneFromPercent(cpu)}
            title={t("homeWorkspace.widgets.btJavaWebsiteMonitor.cpu")}
          />
          <MetricCell
            label={t("homeWorkspace.widgets.btJavaWebsiteMonitor.memoryShort")}
            value={processOverXmx ? `${memValue} !` : memValue}
            percent={memoryPct}
            tone={toneFromPercent(memoryPct, processOverXmx)}
            title={memTip || t("homeWorkspace.widgets.btJavaWebsiteMonitor.memory")}
          />
          <MetricCell
            label={t("homeWorkspace.widgets.btJavaWebsiteMonitor.threadsShort")}
            value={String(threads)}
            percent={thrPct}
            tone={toneFromPercent(thrPct)}
            title={t("homeWorkspace.widgets.btJavaWebsiteMonitor.threads", {
              value: String(threads),
            })}
          />
          <MetricCell
            label={t("homeWorkspace.widgets.btJavaWebsiteMonitor.connectsShort")}
            value={String(connects)}
            percent={connPct}
            tone={toneFromPercent(connPct)}
            title={t("homeWorkspace.widgets.btJavaWebsiteMonitor.connects", {
              value: String(connects),
            })}
          />
        </div>
      ) : (
        <div className="sc-bt-java-mon__idle">
          <span className="sc-bt-java-mon__idle-dot" />
          <span>
            {loading
              ? t("homeWorkspace.widgets.btJavaWebsiteMonitor.loading")
              : t("homeWorkspace.widgets.btJavaWebsiteMonitor.emptyHint")}
          </span>
        </div>
      )}

      <div className="sc-bt-java-mon__meta">
        {loadInfo?.serverPort != null ? (
          <span className="sc-bt-java-mon__meta-item">:{loadInfo.serverPort}</span>
        ) : null}
        {loadInfo?.springProfile ? (
          <span className="sc-bt-java-mon__meta-item">{loadInfo.springProfile}</span>
        ) : null}
        {loadInfo?.heapMaxBytes != null && loadInfo.heapMaxBytes > 0 ? (
          <span className="sc-bt-java-mon__meta-item">
            Xmx {formatCompactBytes(loadInfo.heapMaxBytes)}
          </span>
        ) : null}
        {uptimeLabel ? (
          <span className="sc-bt-java-mon__meta-item">↑ {uptimeLabel}</span>
        ) : null}
        {loadInfo?.pid != null ? (
          <span className="sc-bt-java-mon__meta-item is-muted">#{loadInfo.pid}</span>
        ) : null}
      </div>
    </div>
  );
}
