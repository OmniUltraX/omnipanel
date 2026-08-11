import { useCallback, useEffect, useMemo } from "react";
import { useI18n } from "../../../../i18n";
import { useDockerContainerStats } from "../../../docker/hooks/useDockerContainerStats";
import { pickStats } from "../../../docker/dockerContainerStatsMatch";
import { containerRowLabel } from "../../../docker/dockerResourceLabels";
import { selectDockerSidebarCacheEntry } from "../../../docker/dockerSidebarCache";
import {
  getContainerLifecyclePhase,
  lifecycleStatusLabel,
} from "../../../docker/dockerContainerLifecycle";
import { useDockerSidebarCacheStore } from "../../../../stores/dockerSidebarCacheStore";
import { useDashboardStore } from "../../useDashboardStore";
import type { SmallComponentRenderProps } from "../types";
import {
  clampPercent,
  DockerMetricBar,
  memoryUsageHint,
} from "../dockerMonitorShared/metrics";

export function DockerContainerMonitorView({
  instanceId,
  panelId,
  dataSourceId: dataSourceIdProp,
}: SmallComponentRenderProps) {
  const { t } = useI18n();
  const widget = useDashboardStore(
    (s) =>
      s.customPanels[panelId]?.widgets.find((w) => w.id === instanceId) ?? null,
  );
  const connectionId = dataSourceIdProp ?? widget?.dataSourceId ?? null;
  const containerId =
    widget?.target?.kind === "docker-container"
      ? widget.target.containerId
      : null;

  const sidebarSelector = useCallback(
    selectDockerSidebarCacheEntry(connectionId ?? ""),
    [connectionId],
  );
  const sidebarEntry = useDockerSidebarCacheStore(sidebarSelector);
  const refreshScope = useDockerSidebarCacheStore((s) => s.refreshScope);

  useEffect(() => {
    if (!connectionId || !containerId) return;
    if (sidebarEntry.containers.some((c) => c.id === containerId)) return;
    void refreshScope({
      kind: "category",
      connectionId,
      category: "containers",
    }).catch(() => {});
  }, [connectionId, containerId, refreshScope, sidebarEntry.containers]);

  const container = useMemo(
    () =>
      containerId
        ? (sidebarEntry.containers.find(
            (c) => c.id === containerId || c.shortId === containerId,
          ) ?? null)
        : null,
    [containerId, sidebarEntry.containers],
  );

  const resolveContainerIds = useCallback(() => {
    if (!container?.running) return [];
    const id = container.shortId || container.id;
    return id ? [id] : [];
  }, [container]);

  const { statsById } = useDockerContainerStats(connectionId, {
    enabled: Boolean(connectionId && container?.running),
    resolveContainerIds,
  });

  const stats = container ? pickStats(container, statsById) : null;

  if (!connectionId) {
    return (
      <div className="sc-docker-mon sc-docker-mon--empty">
        <p className="sc-docker-mon__empty-title">
          {t("homeWorkspace.customPanel.dataSource.requiredTitle")}
        </p>
        <p className="sc-docker-mon__empty-hint">
          {t("homeWorkspace.widgets.dockerContainerMonitor.needConnection")}
        </p>
      </div>
    );
  }

  if (!containerId) {
    return (
      <div className="sc-docker-mon sc-docker-mon--empty">
        <p className="sc-docker-mon__empty-title">
          {t("homeWorkspace.customPanel.target.requiredTitle")}
        </p>
        <p className="sc-docker-mon__empty-hint">
          {t("homeWorkspace.widgets.dockerContainerMonitor.needTarget")}
        </p>
      </div>
    );
  }

  if (!container) {
    return (
      <div className="sc-docker-mon sc-docker-mon--empty">
        <p className="sc-docker-mon__empty-title">
          {t("homeWorkspace.widgets.dockerContainerMonitor.notFound")}
        </p>
        <p className="sc-docker-mon__empty-hint">
          {t("homeWorkspace.widgets.dockerContainerMonitor.notFoundHint")}
        </p>
      </div>
    );
  }

  const phase = getContainerLifecyclePhase(container, false);
  const statusLabel = lifecycleStatusLabel(container, phase, t);
  const name = containerRowLabel(container);
  const cpu = container.running ? clampPercent(stats?.cpuPercent) : 0;
  const memory = container.running ? clampPercent(stats?.memoryPercent) : 0;

  return (
    <div className="sc-docker-mon" data-status={phase}>
      <div className="sc-docker-mon__head">
        <span className="sc-docker-mon__name" title={name}>
          {name}
        </span>
        <span
          className={`sc-docker-mon__status sc-docker-mon__status--${phase}`}
        >
          {statusLabel}
        </span>
      </div>
      <p className="sc-docker-mon__image" title={container.image}>
        {container.image}
      </p>
      {container.running ? (
        <div className="sc-docker-mon__metrics">
          <DockerMetricBar label={t("docker.dockPanel.cpu")} value={cpu} />
          <DockerMetricBar
            label={t("docker.dockPanel.memory")}
            value={memory}
            hint={memoryUsageHint(stats)}
            tone={memory >= 85 ? "warn" : "accent"}
          />
        </div>
      ) : (
        <p className="sc-docker-mon__idle">
          {t("docker.composePanel.containerStoppedHint")}
        </p>
      )}
    </div>
  );
}
