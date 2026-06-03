import { useEffect, useRef, useState } from "react";
import { useSshStats, type HostSystemStats } from "../../../../stores/sshStatsStore";
import { useSshMonitoring } from "../../hooks/useSshMonitoring";
import { useI18n } from "../../../../i18n";

type Props = {
  activeResource: { id: string } | null;
};

const MAX_POINTS = 120;

type Point = { ts: number; value: number };

/** 根据两次累计计数计算合并不收发吞吐量（MB/s）。 */
function networkMbps(prev: HostSystemStats, cur: HostSystemStats): number | null {
  if (!prev.network || !cur.network) return null;
  const dt = cur.timestamp - prev.timestamp;
  if (dt <= 0) return null;
  const drx = Math.max(0, cur.network.rxBytes - prev.network.rxBytes);
  const dtx = Math.max(0, cur.network.txBytes - prev.network.txBytes);
  const bytesPerSec = (drx + dtx) / dt;
  return bytesPerSec / (1024 * 1024);
}

function appendPoint(
  history: Point[],
  stats: HostSystemStats,
  extract: (s: HostSystemStats) => number,
): Point[] {
  const v = extract(stats);
  const ts = stats.timestamp * 1000;
  const last = history[history.length - 1];
  if (last && last.ts === ts) return history;
  return [...history.slice(-(MAX_POINTS - 1)), { ts, value: v }];
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function AreaChart({
  data,
  label,
  color,
  unit,
  max,
  waiting,
}: {
  data: Point[];
  label: string;
  color: string;
  unit: string;
  max: number;
  waiting: string;
}) {
  if (data.length < 2) {
    return (
      <div className="monitor-chart">
        <div className="monitor-chart-header">
          <span className="monitor-chart-label">{label}</span>
          <span className="monitor-chart-value">—</span>
        </div>
        <div className="monitor-chart-empty">{waiting}</div>
      </div>
    );
  }

  const w = 480;
  const h = 120;
  const pad = { t: 8, r: 8, b: 24, l: 36 };
  const cw = w - pad.l - pad.r;
  const ch = h - pad.t - pad.b;

  const latest = data[data.length - 1].value;
  const len = data.length;
  const chartMax = Math.max(max, ...data.map((d) => d.value), 0.1) * 1.15;

  const points = data.map((d, i) => ({
    x: pad.l + (len > 1 ? (i / (len - 1)) * cw : cw / 2),
    y: pad.t + ch - (d.value / chartMax) * ch,
  }));

  const lineD = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
  const areaD = `${lineD} L${points[points.length - 1].x},${pad.t + ch} L${points[0].x},${pad.t + ch} Z`;

  const gridLines = [0, 0.25, 0.5, 0.75, 1].map((f) => pad.t + ch * (1 - f));
  const timeTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const idx = Math.round(f * (data.length - 1));
    return data[idx]?.ts ?? 0;
  });

  return (
    <div className="monitor-chart">
      <div className="monitor-chart-header">
        <span className="monitor-chart-label">{label}</span>
        <span className="monitor-chart-value" style={{ color }}>
          {latest.toFixed(2)}
          {unit}
        </span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="monitor-chart-svg">
        <defs>
          <linearGradient id={`grad-${label}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.35" />
            <stop offset="100%" stopColor={color} stopOpacity="0.03" />
          </linearGradient>
        </defs>
        {gridLines.map((y, i) => (
          <line
            key={`g${i}`}
            x1={pad.l}
            y1={y}
            x2={w - pad.r}
            y2={y}
            stroke="var(--border)"
            strokeWidth="0.5"
          />
        ))}
        {gridLines.map((y, i) => {
          const val = (chartMax * (1 - i * 0.25)).toFixed(1);
          return (
            <text
              key={`v${i}`}
              x={pad.l - 4}
              y={y + 3}
              textAnchor="end"
              fill="var(--meta)"
              fontSize="8"
            >
              {val}
            </text>
          );
        })}
        {timeTicks.map((ts, i) => {
          const x = pad.l + (i / 4) * cw;
          return (
            <text
              key={`t${i}`}
              x={x}
              y={h - 4}
              textAnchor="middle"
              fill="var(--meta)"
              fontSize="7"
            >
              {fmtTime(ts)}
            </text>
          );
        })}
        <path d={areaD} fill={`url(#grad-${label})`} />
        <path d={lineD} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
        <circle
          cx={points[points.length - 1].x}
          cy={points[points.length - 1].y}
          r="2.5"
          fill={color}
        />
      </svg>
    </div>
  );
}

export function MonitoringDetailTab({ activeResource }: Props) {
  const { t } = useI18n();
  const rid = activeResource?.id ?? null;
  const stats = useSshStats(rid);
  const { phase, error, refresh } = useSshMonitoring(rid);

  const [cpuSeries, setCpuSeries] = useState<Point[]>([]);
  const [memSeries, setMemSeries] = useState<Point[]>([]);
  const [netSeries, setNetSeries] = useState<Point[]>([]);
  const prevStatsRef = useRef<HostSystemStats | null>(null);

  useEffect(() => {
    setCpuSeries([]);
    setMemSeries([]);
    setNetSeries([]);
    prevStatsRef.current = null;
  }, [rid]);

  useEffect(() => {
    if (!stats) return;
    setCpuSeries((h) => appendPoint(h, stats, (s) => s.cpuUsage));
    setMemSeries((h) =>
      appendPoint(h, stats, (s) => (s.memory.used / (s.memory.total || 1)) * 100),
    );

    const prev = prevStatsRef.current;
    if (prev && prev.timestamp !== stats.timestamp) {
      const mbps = networkMbps(prev, stats);
      if (mbps != null) {
        const ts = stats.timestamp * 1000;
        setNetSeries((h) => {
          const last = h[h.length - 1];
          if (last && last.ts === ts) return h;
          return [...h.slice(-(MAX_POINTS - 1)), { ts, value: mbps }];
        });
      }
    }
    prevStatsRef.current = stats;
  }, [stats]);

  const waitingLabel =
    phase === "loading"
      ? t("ssh.monitoring.loading")
      : phase === "error"
        ? (error ?? t("ssh.monitoring.loadError"))
        : t("ssh.monitoring.waiting");

  if (phase === "error" && cpuSeries.length === 0) {
    return (
      <div className="monitor-panel monitor-panel--error">
        <p className="ssh-ov-error-text">{error ?? t("ssh.monitoring.loadError")}</p>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => refresh()}>
          {t("ssh.overview.retry")}
        </button>
      </div>
    );
  }

  return (
    <div className="monitor-panel">
      <div className="monitor-chart-row">
        <AreaChart
          data={cpuSeries}
          label="CPU"
          color="var(--accent)"
          unit="%"
          max={100}
          waiting={waitingLabel}
        />
        <AreaChart
          data={memSeries}
          label="Memory"
          color="var(--success)"
          unit="%"
          max={100}
          waiting={waitingLabel}
        />
      </div>
      <AreaChart
        data={netSeries}
        label={t("ssh.monitoring.network")}
        color="var(--warn)"
        unit=" MB/s"
        max={10}
        waiting={waitingLabel}
      />
    </div>
  );
}
