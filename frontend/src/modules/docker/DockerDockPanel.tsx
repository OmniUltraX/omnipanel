import { useCallback, useMemo, useState, type MouseEvent } from "react";
import { ModuleEmptyState } from "../../components/ui/feedback/ModuleEmptyState";
import { Button } from "../../components/ui/Button";
import { useI18n } from "../../i18n";
import type { DockerConnectionInfo, DockerContainerStats, DockerContainerSummary } from "../../ipc/bindings";
import { appConfirm } from "../../lib/appConfirm";
import { ContainerIcon, DirectoryIcon, LogsIcon, ParamsIcon } from "./icons";
import { useDockerContainerGrid } from "./hooks/useDockerContainerGrid";
import { DockerContainerSubWindow } from "./subwindows/DockerContainerSubWindow";
import {
  displayValue,
  formatDockerIpAddress,
  formatDockerNetworks,
  formatDockerPorts,
} from "./dockerContainerCardFormat";
import { DockerContainerCardStatusControls } from "./DockerContainerCardStatusControls";
import { runDockerContainerAction } from "./dockerContainerActions";
import {
  getContainerLifecyclePhase,
  lifecycleStatusLabel,
  type DockerContainerLifecycleAction,
} from "./dockerContainerLifecycle";
import { refreshDockerConnectionSidebarCache } from "./hooks/useDockerConnectionResources";

export type DockerContainerSubWindowKind = "detail" | "params" | "logs" | "directory";

export interface DockerDockPanelProps {
  connection: DockerConnectionInfo;
  /** 当前连接 dock 面板处于激活态 */
  isActive: boolean;
  panelTitle?: string;
  panelSubtitle?: string;
  /** 仅展示指定容器 ID；未设置则展示全部 */
  containerIds?: string[];
}

type OpenContainerSubWindow = {
  containerId: string;
  containerName: string;
  kind: DockerContainerSubWindowKind;
};

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

function normalizeContainerKey(containerId: string): string {  return containerId.trim().toLowerCase();
}

function subWindowTitle(kind: DockerContainerSubWindowKind, t: (key: string) => string): string {
  switch (kind) {
    case "detail":
      return t("docker.dockPanel.openDetail");
    case "params":
      return t("docker.dockPanel.params");
    case "logs":
      return t("docker.dockPanel.logs");
    case "directory":
      return t("docker.dockPanel.directory");
  }
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

function ContainerCard({
  container,
  stats,
  t,
  actionPending,
  onOpenDetail,
  onOpenAction,
  onLifecycleAction,
}: {
  container: DockerContainerSummary;
  stats: DockerContainerStats | null;
  t: (key: string) => string;
  actionPending: boolean;
  onOpenDetail: (container: DockerContainerSummary) => void;
  onOpenAction: (container: DockerContainerSummary, kind: DockerContainerSubWindowKind) => void;
  onLifecycleAction: (
    container: DockerContainerSummary,
    action: DockerContainerLifecycleAction,
    event: MouseEvent<HTMLButtonElement>,
  ) => void;
}) {
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
    onOpenAction(container, kind);
  };

  return (
    <article
      className={[
        "docker-container-card",
        running ? "" : " docker-container-card--stopped",
        busy ? " docker-container-card--busy" : "",
      ]
        .join("")
        .trim()}
      role="button"
      tabIndex={busy ? -1 : 0}
      aria-busy={busy}
      onClick={() => {
        if (busy) return;
        onOpenDetail(container);
      }}
      onKeyDown={(event) => {
        if (busy) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpenDetail(container);
        }
      }}
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
    </article>
  );
}


export function DockerDockPanel({
  connection,
  isActive,
  panelTitle,
  panelSubtitle,
  containerIds,
}: DockerDockPanelProps) {
  const { t } = useI18n();
  const { items, loading, error, refreshNow } = useDockerContainerGrid(connection.connectionId, isActive);
  const [openSubWindow, setOpenSubWindow] = useState<OpenContainerSubWindow | null>(null);
  const [pendingActions, setPendingActions] = useState<Record<string, true>>({});
  const [actionError, setActionError] = useState<string | null>(null);

  const containerIdSet = useMemo(() => {
    if (!containerIds?.length) return null;
    return new Set(containerIds.map((id) => id.trim().toLowerCase()));
  }, [containerIds]);

  const filteredItems = useMemo(() => {
    if (!containerIdSet) return items;
    return items.filter((item) => {
      const id = item.container.id.trim().toLowerCase();
      const shortId = item.container.shortId.trim().toLowerCase();
      return containerIdSet.has(id) || containerIdSet.has(shortId);
    });
  }, [containerIdSet, items]);

  const sortedItems = useMemo(
    () =>
      [...filteredItems].sort((a, b) => {
        if (a.container.running !== b.container.running) {
          return a.container.running ? -1 : 1;
        }
        return a.container.name.localeCompare(b.container.name);
      }),
    [filteredItems],
  );

  const openDetail = useCallback((container: DockerContainerSummary) => {
    setOpenSubWindow({
      containerId: container.id,
      containerName: container.name || container.shortId || container.id.slice(0, 12),
      kind: "detail",
    });
  }, []);

  const openAction = useCallback(
    (container: DockerContainerSummary, kind: DockerContainerSubWindowKind) => {
      setOpenSubWindow({
        containerId: container.id,
        containerName: container.name || container.shortId || container.id.slice(0, 12),
        kind,
      });
    },
    [],
  );

  const setContainerPending = useCallback((containerId: string, pending: boolean) => {
    const key = normalizeContainerKey(containerId);
    setPendingActions((current) => {
      if (pending) {
        if (current[key]) return current;
        return { ...current, [key]: true };
      }
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, []);

  const handleLifecycleAction = useCallback(
    (container: DockerContainerSummary, action: DockerContainerLifecycleAction, event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      const containerName = container.name || container.shortId || container.id.slice(0, 12);
      void (async () => {
        if (action === "remove") {
          const confirmed = await appConfirm(
            t("docker.dockPanel.removeContainerConfirm", { name: containerName }),
          );
          if (!confirmed) return;
        }
        setActionError(null);
        setContainerPending(container.id, true);
        try {
          await runDockerContainerAction(connection.connectionId, container.id, action);
          refreshNow();
          refreshDockerConnectionSidebarCache(connection.connectionId);
        } catch (e) {
          setActionError(String(e));
        } finally {
          setContainerPending(container.id, false);
        }
      })();
    },
    [connection.connectionId, refreshNow, setContainerPending, t],
  );

  if (!isActive) {
    return <div className="docker-dock-panel docker-dock-panel--inactive" aria-hidden />;
  }

  return (
    <>
      <div className="docker-dock-panel">
        <div className="docker-dock-panel__header">
          <div>
            <h2 className="docker-dock-panel__title">{panelTitle ?? connection.name}</h2>
            <p className="docker-dock-panel__subtitle">{panelSubtitle ?? connection.hostLabel}</p>
          </div>
          <span className="badge badge-muted">
            {t("docker.dockPanel.containerCount", { count: sortedItems.length })}
          </span>
        </div>

        {error || actionError ? (
          <div className="docker-dock-panel__error">{error ?? actionError}</div>
        ) : null}

        {loading && sortedItems.length === 0 ? (
          <div className="docker-dock-panel__loading">{t("docker.dockPanel.loading")}</div>
        ) : sortedItems.length === 0 ? (
          <ModuleEmptyState preset="container" title={t("docker.dockPanel.empty")} />
        ) : (
          <div className="docker-container-grid">
            {sortedItems.map(({ container, stats }) => (
              <ContainerCard
                key={container.id}
                container={container}
                stats={stats}
                t={t}
                actionPending={Boolean(pendingActions[normalizeContainerKey(container.id)])}
                onOpenDetail={openDetail}
                onOpenAction={openAction}
                onLifecycleAction={handleLifecycleAction}
              />
            ))}
          </div>
        )}
      </div>

      <DockerContainerSubWindow
        open={openSubWindow != null}
        kind={openSubWindow?.kind ?? "params"}
        title={openSubWindow ? subWindowTitle(openSubWindow.kind, t) : ""}
        containerName={openSubWindow?.containerName ?? ""}
        connectionId={connection.connectionId}
        containerId={openSubWindow?.containerId ?? ""}
        onClose={() => setOpenSubWindow(null)}
      />
    </>
  );
}
