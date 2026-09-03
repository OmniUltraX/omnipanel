import { useMemo, useState, type MouseEvent } from "react";
import type { CloudMetricSeries } from "../../ipc/bindings";
import { useI18n } from "../../i18n";
import { FormDialog } from "../../components/ui/form/FormDialog";
import {
  CLOUD_METRIC_CHART_PAD,
  CLOUD_METRIC_RANGE_PRESETS,
  cloudMetricQueryForRange,
  formatMetricTime,
  formatMetricValue,
  isGuestOsMetric,
  metricCardSize,
  metricSeriesStats,
  nearestPlotPoint,
  plotMetricPoints,
  type CloudMetricPlotPoint,
  type CloudMetricRangeId,
} from "./cloudMetricChart";

export { cloudMetricQueryForRange, type CloudMetricRangeId };

function metricTitle(t: (key: string) => string, series: CloudMetricSeries): string {
  const key = `cloud.metrics.ids.${series.id}`;
  const mapped = t(key);
  return mapped !== key ? mapped : series.label || series.id;
}

function displayValue(value: number | undefined, unit: string | undefined): string {
  if (value == null) return "—";
  const formatted = formatMetricValue(value, unit ?? "");
  if (!unit || unit === "%") return formatted;
  return `${formatted} ${unit}`;
}

function MetricSparkline({
  series,
  width,
  height,
  interactive,
  onOpen,
}: {
  series: CloudMetricSeries;
  width: number;
  height: number;
  interactive?: boolean;
  onOpen?: () => void;
}) {
  const { t } = useI18n();
  const [hover, setHover] = useState<CloudMetricPlotPoint | null>(null);
  const plotted = useMemo(() => plotMetricPoints(series, width, height), [height, series, width]);

  const toViewX = (event: MouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return ((event.clientX - rect.left) / Math.max(rect.width, 1)) * width;
  };

  return (
    <div className="cloud-metrics__chart">
      <svg
        className="cloud-metrics__svg"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={metricTitle(t, series)}
        onMouseMove={
          interactive
            ? (event) => setHover(nearestPlotPoint(plotted.points, toViewX(event)))
            : undefined
        }
        onMouseLeave={interactive ? () => setHover(null) : undefined}
        onClick={onOpen}
      >
        {[0, 0.5, 1].map((p) => {
          const y = CLOUD_METRIC_CHART_PAD.t + (height - CLOUD_METRIC_CHART_PAD.t - CLOUD_METRIC_CHART_PAD.b) * (1 - p);
          return (
            <g key={p}>
              <line
                x1={CLOUD_METRIC_CHART_PAD.l}
                x2={width - CLOUD_METRIC_CHART_PAD.r}
                y1={y}
                y2={y}
                className="cloud-metrics__grid"
              />
              <text x={CLOUD_METRIC_CHART_PAD.l - 6} y={y + 3} className="cloud-metrics__tick">
                {formatMetricValue(plotted.max * p, series.unit ?? "")}
              </text>
            </g>
          );
        })}
        {plotted.points.length > 0 ? (
          <>
            <text x={CLOUD_METRIC_CHART_PAD.l} y={height - 6} className="cloud-metrics__axis">
              {formatMetricTime(plotted.points[0]!.ts)}
            </text>
            <text x={width - CLOUD_METRIC_CHART_PAD.r} y={height - 6} className="cloud-metrics__axis cloud-metrics__axis--end">
              {formatMetricTime(plotted.points[plotted.points.length - 1]!.ts)}
            </text>
          </>
        ) : null}
        {plotted.area ? <path d={plotted.area} className="cloud-metrics__area" /> : null}
        {plotted.line ? (
          <path
            d={plotted.line}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ) : null}
        {hover ? (
          <>
            <line
              x1={hover.x}
              x2={hover.x}
              y1={CLOUD_METRIC_CHART_PAD.t}
              y2={height - CLOUD_METRIC_CHART_PAD.b}
              className="cloud-metrics__cross"
            />
            <circle cx={hover.x} cy={hover.y} r="4" className="cloud-metrics__dot" />
          </>
        ) : null}
      </svg>
      {hover ? (
        <div
          className="cloud-metrics__tip"
          style={{ left: `${(hover.x / width) * 100}%`, top: `${(hover.y / height) * 100}%` }}
        >
          <span>{formatMetricTime(hover.ts)}</span>
          <strong>{displayValue(hover.value, series.unit)}</strong>
        </div>
      ) : null}
    </div>
  );
}

export function CloudMetricCharts({
  series,
  rangeId,
  loading,
  error,
  onRangeChange,
  onRefresh,
}: {
  series: CloudMetricSeries[];
  rangeId: CloudMetricRangeId;
  loading?: boolean;
  error?: string | null;
  onRangeChange: (id: CloudMetricRangeId) => void;
  onRefresh: () => void;
}) {
  const { t } = useI18n();
  const [detailId, setDetailId] = useState<string | null>(null);
  const detail = series.find((item) => item.id === detailId) ?? null;
  const stats = metricSeriesStats(detail?.points);

  return (
    <div className="cloud-metrics cloud-panel-card">
      <div className="cloud-metrics__toolbar">
        <div className="cloud-metrics__ranges">
          {CLOUD_METRIC_RANGE_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={`cloud-metrics__range${rangeId === preset.id ? " is-active" : ""}`}
              onClick={() => onRangeChange(preset.id)}
            >
              {t(`cloud.metrics.range.${preset.id}`)}
            </button>
          ))}
        </div>
        <div className="cloud-metrics__toolbar-end">
          <span className="cloud-metrics__hint">{t("cloud.metrics.hint")}</span>
          <button type="button" className="cloud-metrics__refresh" onClick={onRefresh} disabled={loading}>
            {loading ? t("server.refreshing") : t("server.refresh")}
          </button>
        </div>
      </div>
      {error ? <p className="cloud-metrics__error">{error}</p> : null}
      {!error && series.length === 0 && !loading ? (
        <p className="form-hint">{t("cloud.metrics.empty")}</p>
      ) : null}
      <div className="cloud-metrics__cards">
        {series.map((item) => {
          const size = metricCardSize(item.id);
          const width = 480;
          const height = size === "hero" ? 200 : 160;
          const last = item.points?.[item.points.length - 1]?.value;
          return (
            <article
              key={item.id}
              className={`cloud-metrics__card cloud-metrics__card--${size}`}
              role="button"
              tabIndex={0}
              onClick={() => setDetailId(item.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setDetailId(item.id);
                }
              }}
            >
              <div className="cloud-metrics__card-head">
                <strong>{metricTitle(t, item)}</strong>
                <span>{displayValue(last, item.unit)}</span>
              </div>
              <div className="cloud-metrics__chart-wrap">
                <MetricSparkline
                  series={item}
                  width={width}
                  height={height}
                  interactive
                  onOpen={() => setDetailId(item.id)}
                />
                {(item.points?.length ?? 0) === 0 ? (
                  <p className="cloud-metrics__empty">
                    {isGuestOsMetric(item.id) ? t("cloud.metrics.needAgent") : t("cloud.metrics.noPoints")}
                  </p>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
      <FormDialog
        open={Boolean(detail)}
        onClose={() => setDetailId(null)}
        title={detail ? metricTitle(t, detail) : t("cloud.metrics.detailTitle")}
        subtitle={detail ? displayValue(stats?.latest, detail.unit) : undefined}
        size="xl"
        cancelLabel={t("common.close")}
        bodyClassName="cloud-metrics-dialog__body"
      >
        {detail ? (
          <div className="cloud-metrics-dialog">
            {stats ? (
              <div className="cloud-metrics-dialog__stats">
                <div>
                  <span>{t("cloud.metrics.latest")}</span>
                  <strong>{displayValue(stats.latest, detail.unit)}</strong>
                </div>
                <div>
                  <span>{t("cloud.metrics.min")}</span>
                  <strong>{displayValue(stats.min, detail.unit)}</strong>
                </div>
                <div>
                  <span>{t("cloud.metrics.max")}</span>
                  <strong>{displayValue(stats.max, detail.unit)}</strong>
                </div>
                <div>
                  <span>{t("cloud.metrics.avg")}</span>
                  <strong>{displayValue(stats.avg, detail.unit)}</strong>
                </div>
              </div>
            ) : (
              <p className="form-hint">
                {isGuestOsMetric(detail.id) ? t("cloud.metrics.needAgent") : t("cloud.metrics.noPoints")}
              </p>
            )}
            <MetricSparkline series={detail} width={720} height={280} interactive />
          </div>
        ) : null}
      </FormDialog>
    </div>
  );
}
