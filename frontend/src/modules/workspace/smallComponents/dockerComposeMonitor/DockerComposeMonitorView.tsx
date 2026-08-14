import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { Button } from "../../../../components/ui/Button";
import { useI18n } from "../../../../i18n";
import { appConfirm } from "../../../../lib/appConfirm";
import { useComposeProjectContainers } from "../../../docker/hooks/useComposeProjectContainers";
import { containerRowLabel } from "../../../docker/dockerResourceLabels";
import {
  getContainerLifecyclePhase,
  lifecycleStatusLabel,
} from "../../../docker/dockerContainerLifecycle";
import { runDockerContainerAction } from "../../../docker/dockerContainerActions";
import { RestartIcon } from "../../../docker/icons";
import { useDashboardStore, type HomeCustomPanelId } from "../../useDashboardStore";
import type { SmallComponentRenderProps } from "../types";
import {
  composeMonitorFallbackGridHeight,
  gridHeightFromContentPx,
} from "../dockerMonitorShared/composeMonitorLayout";
import {
  clampPercent,
  DockerMetricBar,
  memoryUsageHint,
} from "../dockerMonitorShared/metrics";
import { DOCKER_COMPOSE_MONITOR_SIZES } from "../dockerMonitorShared/sizes";
import { resolveBaseSizePreset } from "../widgetScale";

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
  const setCustomPanelWidgetLayoutHeight = useDashboardStore(
    (s) => s.setCustomPanelWidgetLayoutHeight,
  );
  const connectionId = dataSourceIdProp ?? widget?.dataSourceId ?? null;
  const composeProject =
    widget?.target?.kind === "docker-compose"
      ? widget.target.composeProject
      : "";

  const enabled = Boolean(connectionId && composeProject);
  const { items, loading, error, refreshNow } = useComposeProjectContainers(
    connectionId ?? "",
    composeProject,
    enabled,
  );
  const [pendingRestarts, setPendingRestarts] = useState<Record<string, true>>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const runningCount = items.filter((i) => i.container.running).length;
  const minBaseH =
    resolveBaseSizePreset(DOCKER_COMPOSE_MONITOR_SIZES, widget?.sizeId)?.h ?? 3;
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!enabled) return;
    if (items.length === 0) {
      setCustomPanelWidgetLayoutHeight(
        panelId as HomeCustomPanelId,
        instanceId,
        composeMonitorFallbackGridHeight(minBaseH),
      );
      return;
    }

    const node = contentRef.current;
    if (!node) return;

    const syncHeight = () => {
      const contentPx = node.scrollHeight;
      const nextH = gridHeightFromContentPx(contentPx, minBaseH);
      setCustomPanelWidgetLayoutHeight(
        panelId as HomeCustomPanelId,
        instanceId,
        nextH,
      );
    };

    syncHeight();
    const observer = new ResizeObserver(syncHeight);
    observer.observe(node);
    return () => observer.disconnect();
  }, [
    actionError,
    enabled,
    error,
    instanceId,
    items.length,
    minBaseH,
    panelId,
    runningCount,
    setCustomPanelWidgetLayoutHeight,
  ]);

  const handleRestartContainer = useCallback(
    (containerId: string, displayName: string, event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      if (!connectionId) return;
      void (async () => {
        const confirmed = await appConfirm(
          t("docker.dockPanel.restartContainerConfirm", { name: displayName }),
          t("docker.dockPanel.restartContainer"),
          {
            kind: "warning",
            confirmLabel: t("docker.dockPanel.restartContainer"),
          },
        );
        if (!confirmed) return;
        setActionError(null);
        setPendingRestarts((current) => ({ ...current, [containerId]: true }));
        try {
          await runDockerContainerAction(connectionId, containerId, "restart");
          refreshNow();
        } catch (err) {
          setActionError(String(err));
        } finally {
          setPendingRestarts((current) => {
            const next = { ...current };
            delete next[containerId];
            return next;
          });
        }
      })();
    },
    [connectionId, refreshNow, t],
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

  const displayError = actionError ?? error;

  return (
    <div className="sc-docker-mon sc-docker-mon--compose" ref={contentRef}>
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
          const phase = getContainerLifecyclePhase(
            container,
            Boolean(pendingRestarts[container.id]),
          );
          const statusLabel = lifecycleStatusLabel(container, phase, t);
          const name =
            container.composeService?.trim() || containerRowLabel(container);
          const cpu = container.running
            ? clampPercent(stats?.cpuPercent)
            : 0;
          const memory = container.running
            ? clampPercent(stats?.memoryPercent)
            : 0;
          const restartBusy = Boolean(pendingRestarts[container.id]);
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
                <div className="sc-docker-mon__row-actions">
                  <Button
                    type="button"
                    variant="icon"
                    size="icon-xs"
                    className="sc-docker-mon__row-restart"
                    title={t("docker.dockPanel.restartContainer")}
                    aria-label={t("docker.dockPanel.restartContainer")}
                    disabled={restartBusy || phase === "transitional"}
                    onClick={(event) => handleRestartContainer(container.id, name, event)}
                  >
                    <RestartIcon />
                  </Button>
                  <span
                    className={`sc-docker-mon__status sc-docker-mon__status--${phase}`}
                  >
                    {statusLabel}
                  </span>
                </div>
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
      {displayError ? <p className="sc-docker-mon__error">{displayError}</p> : null}
    </div>
  );
}
