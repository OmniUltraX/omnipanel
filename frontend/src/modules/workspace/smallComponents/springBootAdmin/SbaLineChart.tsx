export type SbaChartSeries = {
  id: string;
  label: string;
  color: string;
  values: number[];
};

export function SbaLineChart({
  series,
  yMax,
  formatY,
}: {
  series: SbaChartSeries[];
  yMax: number;
  formatY: (value: number) => string;
}) {
  const vbW = 320;
  const vbH = 128;
  const padL = 36;
  const padR = 6;
  const padT = 6;
  const padB = 6;
  const innerW = vbW - padL - padR;
  const innerH = vbH - padT - padB;
  const max = yMax > 0 ? yMax : 1;
  const ticks = [0, 0.5, 1].map((p) => max * p);

  function point(values: number[], i: number): { x: number; y: number } {
    const n = Math.max(values.length - 1, 1);
    const x = padL + (i / n) * innerW;
    const y = padT + innerH - (Math.max(0, values[i] ?? 0) / max) * innerH;
    return { x, y };
  }

  function pathD(values: number[]): string {
    if (values.length < 2) return "";
    return values
      .map((_, i) => {
        const { x, y } = point(values, i);
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }

  return (
    <svg
      className="sc-sba__svg"
      viewBox={`0 0 ${vbW} ${vbH}`}
      preserveAspectRatio="none"
      role="img"
    >
      {ticks.map((tick, i) => {
        const y = padT + innerH - (tick / max) * innerH;
        return (
          <g key={i}>
            <line
              x1={padL}
              x2={vbW - padR}
              y1={y}
              y2={y}
              className="sc-sba__grid"
            />
            <text x={padL - 4} y={y + 3} className="sc-sba__tick">
              {formatY(tick)}
            </text>
          </g>
        );
      })}
      {series.map((s) =>
        s.values.length >= 2 ? (
          <path
            key={s.id}
            d={pathD(s.values)}
            fill="none"
            stroke={s.color}
            strokeWidth="1.7"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ) : null,
      )}
    </svg>
  );
}
