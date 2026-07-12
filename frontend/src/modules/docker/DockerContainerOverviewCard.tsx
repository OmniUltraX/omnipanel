import type { MouseEvent } from "react";
import { Button } from "../../components/ui/Button";
import type { DockerContainerStats, DockerContainerSummary } from "../../ipc/bindings";
import {
  displayValue,
  formatDockerIpAddress,
  formatDockerNetworks,
  formatDockerPorts,
} from "./dockerContainerCardFormat";
import { DockerContainerCardStatusControls } from "./DockerContainerCardStatusControls";
import {
  getContainerLifecyclePhase,
  lifecycleStatusLabel,
  type DockerContainerLifecycleAction,
} from "./dockerContainerLifecycle";
import { ContainerIcon, DirectoryIcon, LogsIcon, ParamsIcon } from "./icons";
import type { DockerContainerSubWindowKind } from "./DockerDockPanel";

function clampPercent(value: number | null | undefined): number {
  if (value == null || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function runtimeLabel(container: { running: boolean; statusText: string }): string {
  const text = container.statusText?.trim();
  if (text) return text;
  return container.running ? "Running" : "Exited";
}

const CARD_ACTIONS: Array<{
  kind: Exclude<DockerContainerSubWindowKind, "detail">;
  icon: typeof ParamsIcon;
  labelKey: "docker.dockPanel.params" | "docker.dockPanel.logs" | "docker.dockPanel.directory";
}> = [
  { kind: "params", icon: ParamsIcon, labelKey: "docker.dockPanel.params" },
  { kind: "logs", icon: LogsIcon, labelKey: "docker.dockPanel.logs" },
  { kind: "directory", icon: DirectoryIcon, labelKey: "docker.dockPanel.directory" },
];

function CardMetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="docker-container-card__meta-row">
      <span className="docker-container-card__meta-label">{label}</span>
      <span className="docker-container-card__meta-value" title={value}>
        {value}
      </span>
    </div>
  );
}

function MetricBar({
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
    <div className="docker-container-card__metric">
      <div className="docker-container-card__metric-head">
        <span>{label}</span>
        <span className="docker-container-card__metric-value">
          {percent.toFixed(1)}%
          {hint ? <span className="docker-container-card__metric-hint">{hint}</span> : null}
        </span>
      </div>
      <div className="docker-container-card__bar-track">
        <div
          className={`docker-container-card__bar-fill docker-container-card__bar-fill--${tone}`}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

export interface DockerContainerOverviewCardProps {
  container: DockerContainerSummary;
  stats: DockerContainerStats | null;
  t: (key: string, params?: Record<string, string | number>) => string;
  actionPending: boolean;
  /** 嵌入工作区时为 false，网格卡片为 true */
  navigable?: boolean;
  onOpenDetail?: (container: DockerContainerSummary) => void;
  onOpenAction?: (container: DockerContainerSummary, kind: DockerContainerSubWindowKind) => void;
  onLifecycleAction: (
    container: DockerContainerSummary,
    action: DockerContainerLifecycleAction,
    event: MouseEvent<HTMLButtonElement>,
  ) => void;
}

export function DockerContainerOverviewCard({
  container,
  stats,
  t,
  actionPending,
  navigable = false,
  onOpenDetail,
  onOpenAction,
  onLifecycleAction,
}: DockerContainerOverviewCardProps) {
  const name = container.name || container.shortId || container.id.slice(0, 12);
  const runtime = runtimeLabel(container);
  const lifecyclePhase = getContainerLifecyclePhase(container, actionPending);
  const running = lifecyclePhase === "running";
  const busy = lifecyclePhase === "transitional";
  const cpu = running ? clampPercent(stats?.cpuPercent) : 0;
  const memory = running ? clampPercent(stats?.memoryPercent) : 0;
  const memoryHint =
    running && stats
      ? `${formatBytes(stats.memoryUsageBytes)} / ${stats.memoryLimitBytes ? formatBytes(stats.memoryLimitBytes) : "—"}`
      : undefined;
  const ipText = displayValue(formatDockerIpAddress(container));
  const portsText = displayValue(formatDockerPorts(container));
  const networksText = displayValue(formatDockerNetworks(container));

  const handleActionClick = (
    event: MouseEvent<HTMLButtonElement>,
    kind: DockerContainerSubWindowKind,
  ) => {
    event.stopPropagation();
    onOpenAction?.(container, kind);
  };

  return (
    <article
      className={[
        "docker-container-card",
        navigable ? "docker-container-card--navigable" : "docker-container-card--embedded",
        running ? "" : " docker-container-card--stopped",
        busy ? " docker-container-card--busy" : "",
      ]
        .join("")
        .trim()}
      role={navigable ? "button" : undefined}
      tabIndex={navigable && !busy ? 0 : undefined}
      aria-busy={busy}
      onClick={
        navigable
          ? () => {
              if (busy) return;
              onOpenDetail?.(container);
            }
          : undefined
      }
      onKeyDown={
        navigable
          ? (event) => {
              if (busy) return;
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onOpenDetail?.(container);
              }
            }
          : undefined
      }
    >
      <div className="docker-container-card__head">
        <div className="docker-container-card__icon" aria-hidden>
          <ContainerIcon />
        </div>
        <div className="docker-container-card__title-wrap">
          <h3 className="docker-container-card__title" title={name}>
            {name}
          </h3>
          <p className="docker-container-card__runtime" title={runtime}>
            {runtime}
          </p>
        </div>
        <div className="docker-container-card__status-wrap">
          <span
            className={[
              "docker-container-card__status",
              running ? "is-running" : "",
              busy ? "is-transition" : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            {lifecycleStatusLabel(container, lifecyclePhase, t)}
          </span>
          <DockerContainerCardStatusControls
            phase={lifecyclePhase}
            busy={actionPending}
            onAction={(action, event) => onLifecycleAction(container, action, event)}
          />
        </div>
      </div>
      <div className="docker-container-card__meta">
        <CardMetaRow label={t("docker.dockPanel.ip")} value={ipText} />
        <CardMetaRow label={t("docker.dockPanel.ports")} value={portsText} />
        <CardMetaRow label={t("docker.dockPanel.networks")} value={networksText} />
      </div>
      <div className="docker-container-card__metrics">
        <MetricBar
          label={t("docker.dockPanel.cpu")}
          value={cpu}
          tone={cpu >= 85 ? "warn" : "accent"}
        />
        <MetricBar
          label={t("docker.dockPanel.memory")}
          value={memory}
          hint={memoryHint}
          tone={memory >= 85 ? "warn" : "accent"}
        />
      </div>
      {onOpenAction ? (
        <footer className="docker-container-card__footer">
          {CARD_ACTIONS.map(({ kind, icon: ActionIcon, labelKey }) => (
            <Button
              key={kind}
              type="button"
              variant="icon"
              size="icon-xs"
              className="docker-container-card__action"
              title={t(labelKey)}
              aria-label={t(labelKey)}
              disabled={busy}
              onClick={(event) => handleActionClick(event, kind)}
            >
              <ActionIcon size={13} />
            </Button>
          ))}
        </footer>
      ) : null}
    </article>
  );
}
