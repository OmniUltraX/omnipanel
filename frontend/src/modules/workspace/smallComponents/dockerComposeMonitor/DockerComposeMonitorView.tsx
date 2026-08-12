import { useComposeProjectContainers } from "../../../docker/hooks/useComposeProjectContainers";
import { containerRowLabel } from "../../../docker/dockerResourceLabels";
import {
  getContainerLifecyclePhase,
  lifecycleStatusLabel,
} from "../../../docker/dockerContainerLifecycle";
import { useI18n } from "../../../../i18n";
import { useDashboardStore } from "../../useDashboardStore";
import type { SmallComponentRenderProps } from "../types";
import {
  clampPercent,
  DockerMetricBar,
  memoryUsageHint,
} from "../dockerMonitorShared/metrics";

export function DockerComposeMonitorView({
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
  const composeProject =
    widget?.target?.kind === "docker-compose"
      ? widget.target.composeProject
      : "";

  const enabled = Boolean(connectionId && composeProject);
  const { items, loading, error } = useComposeProjectContainers(
    connectionId ?? "",
    composeProject,
    enabled,
  );

  if (!connectionId) {
    return (
      <div className="sc-docker-mon sc-docker-mon--empty">
        <p className="sc-docker-mon__empty-title">
          {t("homeWorkspace.customPanel.dataSource.requiredTitle")}
        </p>
        <p className="sc-docker-mon__empty-hint">
          {t("homeWorkspace.widgets.dockerComposeMonitor.needConnection")}
        </p>
      </div>
    );
  }

  if (!composeProject) {
    return (
      <div className="sc-docker-mon sc-docker-mon--empty">
        <p className="sc-docker-mon__empty-title">
          {t("homeWorkspace.customPanel.target.requiredTitle")}
        </p>
        <p className="sc-docker-mon__empty-hint">
          {t("homeWorkspace.widgets.dockerComposeMonitor.needTarget")}
        </p>
      </div>
    );
  }

  if (loading && items.length === 0) {
    return (
      <div className="sc-docker-mon sc-docker-mon--empty">
        <p className="sc-docker-mon__empty-hint">{t("docker.dockPanel.loading")}</p>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="sc-docker-mon sc-docker-mon--empty">
        <p className="sc-docker-mon__empty-title">
          {t("homeWorkspace.widgets.dockerComposeMonitor.empty")}
        </p>
        {error ? (
          <p className="sc-docker-mon__empty-hint">{error}</p>
        ) : (
          <p className="sc-docker-mon__empty-hint">
            {t("homeWorkspace.widgets.dockerComposeMonitor.emptyHint")}
          </p>
        )}
      </div>
    );
  }

  const runningCount = items.filter((i) => i.container.running).length;

  return (
    <div className="sc-docker-mon sc-docker-mon--compose">
      <div className="sc-docker-mon__head">
        <span className="sc-docker-mon__name" title={composeProject}>
          {composeProject}
        </span>
        <span className="sc-docker-mon__status sc-docker-mon__status--meta">
          {t("homeWorkspace.widgets.dockerComposeMonitor.projectMeta", {
            running: runningCount,
            total: items.length,
          })}
        </span>
      </div>
      <div className="sc-docker-mon__list">
        {items.map(({ container, stats }) => {
          const phase = getContainerLifecyclePhase(container, false);
          const statusLabel = lifecycleStatusLabel(container, phase, t);
          const name =
            container.composeService?.trim() || containerRowLabel(container);
          const cpu = container.running
            ? clampPercent(stats?.cpuPercent)
            : 0;
          const memory = container.running
            ? clampPercent(stats?.memoryPercent)
            : 0;
          return (
            <article
              key={container.id}
              className="sc-docker-mon__row"
              data-status={phase}
            >
              <div className="sc-docker-mon__row-head">
                <span className="sc-docker-mon__row-name" title={name}>
                  {name}
                </span>
                <span
                  className={`sc-docker-mon__status sc-docker-mon__status--${phase}`}
                >
                  {statusLabel}
                </span>
              </div>
              {container.running ? (
                <div className="sc-docker-mon__metrics sc-docker-mon__metrics--compact">
                  <DockerMetricBar
                    label={t("docker.dockPanel.cpu")}
                    value={cpu}
                  />
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
            </article>
          );
        })}
      </div>
      {error ? <p className="sc-docker-mon__error">{error}</p> : null}
    </div>
  );
}
