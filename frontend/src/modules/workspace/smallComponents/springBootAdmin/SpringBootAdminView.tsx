import { useEffect, useMemo, useState } from "react";
import { commands, type SbaJvmSnapshot } from "../../../../ipc/bindings";
import { formatIpcError, unwrapCommand } from "../../../../ipc/result";
import { useI18n } from "../../../../i18n";
import { useDashboardStore } from "../../useDashboardStore";
import type { SmallComponentController, SmallComponentRenderProps } from "../types";
import { formatJvmBytes, formatThreadCount, niceAxisMax } from "./format";
import {
  getSbaHistory,
  pushSbaSample,
  sbaHistoryKey,
  seriesValues,
  snapshotToSample,
  sampleToSnapshot,
  type SbaSample,
} from "./history";
import {
  SBA_CHART_COLORS,
  SPRING_BOOT_ADMIN_REFRESH_MS,
  springBootAdminChartLayout,
} from "./layout";
import { SbaLineChart, type SbaChartSeries } from "./SbaLineChart";
import "./SpringBootAdminView.css";

type MonitorController = SmallComponentController & {
  subscribe: (listener: () => void) => () => void;
  revision: number;
};

function asMonitorController(
  controller: SmallComponentController | undefined,
): MonitorController | null {
  if (!controller) return null;
  const c = controller as MonitorController;
  if (typeof c.subscribe !== "function") return null;
  return c;
}

function Stat({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div className="sc-sba__stat">
      {color ? (
        <span className="sc-sba__swatch" style={{ background: color }} />
      ) : (
        <span className="sc-sba__swatch sc-sba__swatch--empty" />
      )}
      <span className="sc-sba__stat-label">{label}:</span>
      <span className="sc-sba__stat-value">{value}</span>
    </div>
  );
}

function ChartCard({
  title,
  stats,
  series,
  yMax,
  formatY,
}: {
  title: string;
  stats: { label: string; value: string; seriesId?: string }[];
  series: SbaChartSeries[];
  yMax: number;
  formatY: (value: number) => string;
}) {
  const colorBySeries = new Map(series.map((s) => [s.id, s.color]));
  return (
    <section className="sc-sba__card">
      <h3 className="sc-sba__card-title">{title}</h3>
      <div className="sc-sba__body">
        <div className="sc-sba__stats">
          {stats.map((s) => (
            <Stat
              key={s.label}
              label={s.label}
              value={s.value}
              color={s.seriesId ? colorBySeries.get(s.seriesId) : undefined}
            />
          ))}
        </div>
        <div className="sc-sba__chart">
          <SbaLineChart series={series} yMax={yMax} formatY={formatY} />
        </div>
      </div>
    </section>
  );
}

function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="sc-sba sc-sba--empty">
      <p className="sc-sba__empty-title">{title}</p>
      <p className="sc-sba__empty-hint">{hint}</p>
    </div>
  );
}

export function SpringBootAdminView({
  instanceId,
  panelId,
  controller,
}: SmallComponentRenderProps) {
  const { t } = useI18n();
  const widget = useDashboardStore(
    (s) =>
      s.customPanels[panelId]?.widgets.find((w) => w.id === instanceId) ?? null,
  );
  const monitor = asMonitorController(controller);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!monitor) return;
    return monitor.subscribe(() => setTick((n) => n + 1));
  }, [monitor]);

  const target =
    widget?.target?.kind === "spring-boot-admin" ? widget.target : null;
  const adminUrl = target?.adminUrl?.trim() ?? "";
  const instanceTargetId = target?.instanceId?.trim() ?? "";
  const layout = springBootAdminChartLayout(widget?.sizeId);

  const [latest, setLatest] = useState<SbaJvmSnapshot | null>(null);
  const [samples, setSamples] = useState<SbaSample[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!adminUrl || !instanceTargetId) {
      setLatest(null);
      setSamples([]);
      setError(null);
      setLoading(false);
      return;
    }
    setSamples(getSbaHistory(sbaHistoryKey(adminUrl, instanceTargetId)));
  }, [adminUrl, instanceTargetId]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    async function load() {
      if (!adminUrl || !instanceTargetId) return;
      setLoading(true);
      try {
        const snap = await unwrapCommand(
          commands.springBootAdminJvmSnapshot(adminUrl, instanceTargetId),
        );
        if (cancelled) return;
        const key = sbaHistoryKey(adminUrl, instanceTargetId);
        const next = pushSbaSample(key, snapshotToSample(snap));
        setLatest(snap);
        setSamples(next);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(formatIpcError(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    if (!adminUrl || !instanceTargetId) {
      return;
    }

    void load();
    timer = window.setInterval(() => {
      void load();
    }, SPRING_BOOT_ADMIN_REFRESH_MS);

    return () => {
      cancelled = true;
      if (timer != null) window.clearInterval(timer);
    };
  }, [adminUrl, instanceTargetId, monitor?.revision]);

  const threadLive = seriesValues(samples, (s) => s.threadsLive);
  const threadDaemon = seriesValues(samples, (s) => s.threadsDaemon);
  const threadPeak = seriesValues(samples, (s) => s.threadsPeak);
  const heapUsed = seriesValues(samples, (s) => s.heapUsed);
  const heapCommitted = seriesValues(samples, (s) => s.heapCommitted);
  const nonHeapUsed = seriesValues(samples, (s) => s.nonHeapUsed);
  const nonHeapCommitted = seriesValues(samples, (s) => s.nonHeapCommitted);
  const nonHeapInit = seriesValues(samples, (s) => s.nonHeapInit);

  const threadSeries = useMemo<SbaChartSeries[]>(() => {
    const list: SbaChartSeries[] = [];
    if (threadLive.length) {
      list.push({
        id: "live",
        label: t("homeWorkspace.widgets.springBootAdmin.live"),
        color: SBA_CHART_COLORS.used,
        values: threadLive,
      });
    }
    if (threadDaemon.length) {
      list.push({
        id: "daemon",
        label: t("homeWorkspace.widgets.springBootAdmin.daemon"),
        color: SBA_CHART_COLORS.committed,
        values: threadDaemon,
      });
    }
    if (threadPeak.length) {
      list.push({
        id: "peak",
        label: t("homeWorkspace.widgets.springBootAdmin.peak"),
        color: SBA_CHART_COLORS.peak,
        values: threadPeak,
      });
    }
    return list;
  }, [t, threadDaemon, threadLive, threadPeak]);

  const heapSeries = useMemo<SbaChartSeries[]>(() => {
    const list: SbaChartSeries[] = [];
    if (heapUsed.length) {
      list.push({
        id: "used",
        label: t("homeWorkspace.widgets.springBootAdmin.used"),
        color: SBA_CHART_COLORS.used,
        values: heapUsed,
      });
    }
    if (heapCommitted.length) {
      list.push({
        id: "committed",
        label: t("homeWorkspace.widgets.springBootAdmin.committed"),
        color: SBA_CHART_COLORS.committed,
        values: heapCommitted,
      });
    }
    return list;
  }, [heapCommitted, heapUsed, t]);

  const nonHeapSeries = useMemo<SbaChartSeries[]>(() => {
    const list: SbaChartSeries[] = [];
    if (nonHeapUsed.length) {
      list.push({
        id: "used",
        label: t("homeWorkspace.widgets.springBootAdmin.used"),
        color: SBA_CHART_COLORS.used,
        values: nonHeapUsed,
      });
    }
    if (nonHeapCommitted.length) {
      list.push({
        id: "committed",
        label: t("homeWorkspace.widgets.springBootAdmin.committed"),
        color: SBA_CHART_COLORS.committed,
        values: nonHeapCommitted,
      });
    }
    if (nonHeapInit.length) {
      list.push({
        id: "init",
        label: t("homeWorkspace.widgets.springBootAdmin.init"),
        color: SBA_CHART_COLORS.init,
        values: nonHeapInit,
      });
    }
    return list;
  }, [nonHeapCommitted, nonHeapInit, nonHeapUsed, t]);

  if (!adminUrl) {
    return (
      <EmptyState
        title={t("homeWorkspace.customPanel.target.requiredTitle")}
        hint={t("homeWorkspace.widgets.springBootAdmin.needUrl")}
      />
    );
  }

  if (!instanceTargetId) {
    return (
      <EmptyState
        title={t("homeWorkspace.customPanel.target.requiredTitle")}
        hint={t("homeWorkspace.widgets.springBootAdmin.needInstance")}
      />
    );
  }

  if (error && !latest && samples.length === 0) {
    return (
      <EmptyState
        title={t("homeWorkspace.widgets.springBootAdmin.loadFailed")}
        hint={error}
      />
    );
  }

  if (!latest && samples.length === 0) {
    return (
      <EmptyState
        title={t("homeWorkspace.widgets.springBootAdmin.loading")}
        hint={t("homeWorkspace.widgets.springBootAdmin.loadingHint")}
      />
    );
  }

  const current =
    latest ?? sampleToSnapshot(samples[samples.length - 1]!);
  const heapY = niceAxisMax(
    [...heapUsed, ...heapCommitted],
    current.heapMax ?? null,
  );
  const nonHeapY = niceAxisMax([
    ...nonHeapUsed,
    ...nonHeapCommitted,
    ...nonHeapInit,
  ]);
  const threadY = niceAxisMax([...threadLive, ...threadDaemon, ...threadPeak]);

  return (
    <div className="sc-sba" data-layout={layout} data-loading={loading ? "1" : "0"}>
      {error ? <p className="sc-sba__empty-hint">{error}</p> : null}
      <div className="sc-sba__charts">
        <ChartCard
          title={t("homeWorkspace.widgets.springBootAdmin.threads")}
          stats={[
            {
              label: t("homeWorkspace.widgets.springBootAdmin.live"),
              value: formatThreadCount(current.threadsLive),
              seriesId: "live",
            },
            {
              label: t("homeWorkspace.widgets.springBootAdmin.daemon"),
              value: formatThreadCount(current.threadsDaemon),
              seriesId: "daemon",
            },
            {
              label: t("homeWorkspace.widgets.springBootAdmin.peak"),
              value: formatThreadCount(current.threadsPeak),
              seriesId: "peak",
            },
          ]}
          series={threadSeries}
          yMax={threadY}
          formatY={(v) => formatThreadCount(v)}
        />
        <ChartCard
          title={t("homeWorkspace.widgets.springBootAdmin.heap")}
          stats={[
            {
              label: t("homeWorkspace.widgets.springBootAdmin.used"),
              value: formatJvmBytes(current.heapUsed),
              seriesId: "used",
            },
            {
              label: t("homeWorkspace.widgets.springBootAdmin.available"),
              value: formatJvmBytes(current.heapCommitted),
              seriesId: "committed",
            },
            {
              label: t("homeWorkspace.widgets.springBootAdmin.max"),
              value: formatJvmBytes(current.heapMax),
            },
          ]}
          series={heapSeries}
          yMax={heapY}
          formatY={formatJvmBytes}
        />
        <ChartCard
          title={t("homeWorkspace.widgets.springBootAdmin.nonHeap")}
          stats={[
            {
              label: t("homeWorkspace.widgets.springBootAdmin.init"),
              value: formatJvmBytes(current.nonHeapInit),
              seriesId: "init",
            },
            {
              label: t("homeWorkspace.widgets.springBootAdmin.used"),
              value: formatJvmBytes(current.nonHeapUsed),
              seriesId: "used",
            },
            {
              label: t("homeWorkspace.widgets.springBootAdmin.available"),
              value: formatJvmBytes(current.nonHeapCommitted),
              seriesId: "committed",
            },
            {
              label: t("homeWorkspace.widgets.springBootAdmin.max"),
              value: formatJvmBytes(current.nonHeapMax),
            },
          ]}
          series={nonHeapSeries}
          yMax={nonHeapY}
          formatY={formatJvmBytes}
        />
      </div>
    </div>
  );
}
