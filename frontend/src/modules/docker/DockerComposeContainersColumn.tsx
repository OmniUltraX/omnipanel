import { memo, useCallback, useEffect, useState, type MouseEvent } from "react";
import { Button } from "../../components/ui/Button";
import { ModuleEmptyState } from "../../components/ui/feedback/ModuleEmptyState";
import { useI18n } from "../../i18n";
import type {
  DockerConnectionInfo,
  DockerContainerStats,
  DockerContainerSummary,
} from "../../ipc/bindings";
import { runDockerContainerAction } from "./dockerContainerActions";
import {
  getContainerLifecyclePhase,
  lifecycleStatusLabel,
  type DockerContainerLifecycleAction,
} from "./dockerContainerLifecycle";
import {
  composeLogServiceKey,
  isComposeLogServiceEnabled,
} from "./dockerComposePanelCache";
import { containerRowLabel } from "./dockerResourceLabels";
import { useComposeProjectContainers } from "./hooks/useComposeProjectContainers";
import { LogsIcon, PlayIcon, RestartIcon, StopIcon } from "./icons";

function clampPercent(value: number | null | undefined): number {
  if (value == null || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function memoryHint(stats: DockerContainerStats | null): string | undefined {
  if (!stats) return undefined;
  const usage = formatBytes(stats.memoryUsageBytes);
  const limit = formatBytes(stats.memoryLimitBytes ?? undefined);
  if (!usage) return undefined;
  return limit ? `${usage} / ${limit}` : usage;
}

function ComposeMetricBar({
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
    <div className="docker-compose-panel__metric">
      <div className="docker-compose-panel__metric-head">
        <span>{label}</span>
        <span className="docker-compose-panel__metric-value">
          {percent.toFixed(1)}%
          {hint ? <span className="docker-compose-panel__metric-hint">{hint}</span> : null}
        </span>
      </div>
      <div className="docker-compose-panel__bar-track">
        <div
          className={`docker-compose-panel__bar-fill docker-compose-panel__bar-fill--${tone}`}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

function ComposeContainerActions({
  phase,
  busy,
  onAction,
  t,
}: {
  phase: ReturnType<typeof getContainerLifecyclePhase>;
  busy: boolean;
  onAction: (action: DockerContainerLifecycleAction, event: MouseEvent<HTMLButtonElement>) => void;
  t: (key: string) => string;
}) {
  if (phase === "transitional" || busy) {
    return (
      <div className="docker-compose-panel__container-actions docker-compose-panel__container-actions--busy">
        <span className="docker-compose-panel__container-spinner" aria-hidden />
      </div>
    );
  }

  if (phase === "running") {
    return (
      <div className="docker-compose-panel__container-actions">
        <Button
          type="button"
          variant="icon"
          size="icon-xs"
          className="docker-compose-panel__container-action-btn"
          title={t("docker.dockPanel.stopContainer")}
          aria-label={t("docker.dockPanel.stopContainer")}
          onClick={(event) => onAction("stop", event)}
        >
          <StopIcon />
        </Button>
        <Button
          type="button"
          variant="icon"
          size="icon-xs"
          className="docker-compose-panel__container-action-btn"
          title={t("docker.dockPanel.restartContainer")}
          aria-label={t("docker.dockPanel.restartContainer")}
          onClick={(event) => onAction("restart", event)}
        >
          <RestartIcon />
        </Button>
      </div>
    );
  }

  return (
    <div className="docker-compose-panel__container-actions">
      <Button
        type="button"
        variant="icon"
        size="icon-xs"
        className="docker-compose-panel__container-action-btn docker-compose-panel__container-action-btn--start"
        title={t("docker.dockPanel.startContainer")}
        aria-label={t("docker.dockPanel.startContainer")}
        onClick={(event) => onAction("start", event)}
      >
        <PlayIcon />
      </Button>
    </div>
  );
}

type ComposeContainerRowProps = {
  container: DockerContainerSummary;
  stats: DockerContainerStats | null;
  busy: boolean;
  logsEnabled: boolean;
  onToggleLogs: (containerId: string, event: MouseEvent<HTMLButtonElement>) => void;
  onAction: (
    containerId: string,
    action: DockerContainerLifecycleAction,
    event: MouseEvent<HTMLButtonElement>,
  ) => void;
  t: (key: string) => string;
};

const ComposeContainerRow = memo(function ComposeContainerRow({
  container,
  stats,
  busy,
  logsEnabled,
  onToggleLogs,
  onAction,
  t,
}: ComposeContainerRowProps) {
  const phase = getContainerLifecyclePhase(container, busy);
  const statusLabel = lifecycleStatusLabel(container, phase, t);
  const cpu = container.running ? (stats?.cpuPercent ?? 0) : 0;
  const memory = container.running ? (stats?.memoryPercent ?? 0) : 0;
  const name = container.composeService?.trim() || containerRowLabel(container);
  const logsToggleLabel = logsEnabled
    ? t("docker.composePanel.logsExclude")
    : t("docker.composePanel.logsInclude");

  return (
    <article className={`docker-compose-panel__container-card docker-compose-panel__container-card--${phase}`}>
      <div className="docker-compose-panel__container-card-top">
        <div className="docker-compose-panel__container-identity">
          <span className="docker-compose-panel__container-name" title={name}>
            {name}
          </span>
          <span className="docker-compose-panel__container-image" title={container.image}>
            {container.image}
          </span>
        </div>
        <div className="docker-compose-panel__container-toolbar">
          <span
            className={`docker-compose-panel__container-status docker-compose-panel__container-status--${phase}`}
          >
            {statusLabel}
          </span>
          <ComposeContainerActions
            phase={phase}
            busy={busy}
            onAction={(action, event) => onAction(container.id, action, event)}
            t={t}
          />
          <Button
            type="button"
            variant="icon"
            size="icon-xs"
            className={[
              "docker-compose-panel__container-action-btn",
              "docker-compose-panel__container-logs-toggle",
              logsEnabled ? "is-on" : "is-off",
            ].join(" ")}
            title={logsToggleLabel}
            aria-label={logsToggleLabel}
            aria-pressed={logsEnabled}
            onClick={(event) => onToggleLogs(container.id, event)}
          >
            <LogsIcon active={logsEnabled} />
          </Button>
        </div>
      </div>
      {container.running ? (
        <div className="docker-compose-panel__container-metrics">
          <ComposeMetricBar label={t("docker.dockPanel.cpu")} value={cpu} />
          <ComposeMetricBar
            label={t("docker.dockPanel.memory")}
            value={memory}
            hint={memoryHint(stats)}
            tone={memory >= 85 ? "warn" : "accent"}
          />
        </div>
      ) : (
        <p className="docker-compose-panel__container-idle">{t("docker.composePanel.containerStoppedHint")}</p>
      )}
    </article>
  );
});

export type DockerComposeContainersColumnProps = {
  connection: DockerConnectionInfo;
  composeProject: string;
  isActive: boolean;
  /** 递增时触发容器列表/stats 刷新（编排生命周期后） */
  refreshToken?: number;
  logEnabledByService: Record<string, boolean>;
  onLogEnabledByServiceChange: (next: Record<string, boolean>) => void;
  onActionError: (message: string | null) => void;
};

/** 仅订阅 containers/stats，与编辑器/日志列隔离，避免 stats 轮询拖垮 CodeEditor。 */
export function DockerComposeContainersColumn({
  connection,
  composeProject,
  isActive,
  refreshToken = 0,
  logEnabledByService,
  onLogEnabledByServiceChange,
  onActionError,
}: DockerComposeContainersColumnProps) {
  const { t } = useI18n();
  const { items: projectContainers, loading, error, refreshNow } = useComposeProjectContainers(
    connection.connectionId,
    composeProject,
    isActive,
  );
  const [pendingContainerActions, setPendingContainerActions] = useState<Record<string, true>>({});

  useEffect(() => {
    if (!isActive || refreshToken <= 0) return;
    refreshNow();
  }, [isActive, refreshNow, refreshToken]);

  const handleContainerLifecycle = useCallback(
    (
      containerId: string,
      action: DockerContainerLifecycleAction,
      event: MouseEvent<HTMLButtonElement>,
    ) => {
      event.stopPropagation();
      void (async () => {
        onActionError(null);
        setPendingContainerActions((current) => ({ ...current, [containerId]: true }));
        try {
          await runDockerContainerAction(connection.connectionId, containerId, action);
          refreshNow();
        } catch (e) {
          onActionError(String(e));
        } finally {
          setPendingContainerActions((current) => {
            const next = { ...current };
            delete next[containerId];
            return next;
          });
        }
      })();
    },
    [connection.connectionId, onActionError, refreshNow],
  );

  const handleToggleContainerLogs = useCallback(
    (containerId: string, event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      const container = projectContainers.find((item) => item.container.id === containerId)?.container;
      if (!container) return;
      const key = composeLogServiceKey(container);
      onLogEnabledByServiceChange({
        ...logEnabledByService,
        [key]: !isComposeLogServiceEnabled(key, logEnabledByService),
      });
    },
    [logEnabledByService, onLogEnabledByServiceChange, projectContainers],
  );

  return (
    <div className="docker-compose-panel__list-wrap">
      <div className="docker-compose-panel__list-header">
        <span>{t("docker.composePanel.containers")}</span>
        <span className="docker-compose-panel__list-count">{projectContainers.length}</span>
      </div>
      <div className="docker-compose-panel__list-body">
        {loading && projectContainers.length === 0 ? (
          <div className="docker-compose-panel__list-loading">{t("docker.dockPanel.loading")}</div>
        ) : projectContainers.length === 0 ? (
          <ModuleEmptyState preset="container" title={t("docker.composePanel.noContainers")} />
        ) : (
          projectContainers.map(({ container, stats }) => {
            const serviceKey = composeLogServiceKey(container);
            return (
              <ComposeContainerRow
                key={container.id}
                container={container}
                stats={stats}
                busy={Boolean(pendingContainerActions[container.id])}
                logsEnabled={isComposeLogServiceEnabled(serviceKey, logEnabledByService)}
                onToggleLogs={handleToggleContainerLogs}
                onAction={handleContainerLifecycle}
                t={t}
              />
            );
          })
        )}
      </div>
      {error ? <div className="docker-compose-panel__list-error">{error}</div> : null}
    </div>
  );
}
