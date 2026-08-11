import type { DockerContainerStats } from "../../../../ipc/bindings";

export function clampPercent(value: number | null | undefined): number {
  if (value == null || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

export function formatDockerBytes(bytes: number | null | undefined): string {
  if (bytes == null || bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function memoryUsageHint(
  stats: DockerContainerStats | null,
): string | undefined {
  if (!stats) return undefined;
  const usage = formatDockerBytes(stats.memoryUsageBytes);
  const limit = formatDockerBytes(stats.memoryLimitBytes ?? undefined);
  if (usage === "—") return undefined;
  return limit !== "—" ? `${usage} / ${limit}` : usage;
}

export function DockerMetricBar({
  label,
  value,
  hint,
  tone = "accent",
}: {
  label: string;
  value: number;
  hint?: string;
  tone?: "accent" | "warn";
}) {
  const percent = clampPercent(value);
  return (
    <div className="sc-docker-mon__metric">
      <div className="sc-docker-mon__metric-head">
        <span>{label}</span>
        <span className="sc-docker-mon__metric-value">
          {percent.toFixed(1)}%
          {hint ? (
            <span className="sc-docker-mon__metric-hint">{hint}</span>
          ) : null}
        </span>
      </div>
      <div className="sc-docker-mon__bar-track" aria-hidden>
        <div
          className={`sc-docker-mon__bar-fill sc-docker-mon__bar-fill--${tone}`}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
