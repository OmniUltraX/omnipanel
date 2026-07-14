import { useMemo, type MouseEvent } from "react";
import {
  DbTablesPanelGrid,
  type DbTablesPanelGridColumn,
  type DbTablesPanelGridSortDirection,
} from "../database/workspace/DbTablesPanelGrid";
import { Button } from "../../components/ui/Button";
import { useI18n } from "../../i18n";
import type { DockerContainerSummary } from "../../ipc/bindings";
import {
  displayValue,
  formatDockerNetworks,
  formatDockerPorts,
} from "./dockerContainerCardFormat";
import { DockerContainerCardStatusControls } from "./DockerContainerCardStatusControls";
import {
  getContainerLifecyclePhase,
  lifecycleStatusLabel,
  type DockerContainerLifecycleAction,
} from "./dockerContainerLifecycle";
import type { DockerContainerGridItem } from "./hooks/useDockerContainerGrid";
import { DirectoryIcon, LogsIcon, ParamsIcon } from "./icons";
import type { DockerContainerSubWindowKind } from "./DockerDockPanel";

export type DockerContainerTableSortColumn =
  | "name"
  | "status"
  | "image"
  | "cpu"
  | "memory"
  | "networks";

function clampPercent(value: number | null | undefined): number {
  if (value == null || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function formatPercent(value: number | null | undefined, running: boolean): string {
  if (!running) return "—";
  return `${clampPercent(value).toFixed(1)}%`;
}

function TableMetricCell({
  value,
  running,
}: {
  value: number | null | undefined;
  running: boolean;
}) {
  if (!running) {
    return <span className="docker-container-table__metric-idle">—</span>;
  }
  const percent = clampPercent(value);
  const tone = percent >= 85 ? "warn" : "accent";
  return (
    <div className="docker-container-table__metric" title={`${percent.toFixed(1)}%`}>
      <span className="docker-container-table__metric-value">{percent.toFixed(1)}%</span>
      <div className="docker-container-table__bar-track" aria-hidden>
        <div
          className={`docker-container-table__bar-fill docker-container-table__bar-fill--${tone}`}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

type DockerContainerListTableProps = {
  items: DockerContainerGridItem[];
  pendingActions: Record<string, true>;
  sortColumnId: DockerContainerTableSortColumn;
  sortDirection: DbTablesPanelGridSortDirection;
  onSortColumn: (sortId: string) => void;
  onOpenAction: (container: DockerContainerSummary, kind: DockerContainerSubWindowKind) => void;
  onLifecycleAction: (
    container: DockerContainerSummary,
    action: DockerContainerLifecycleAction,
    event: MouseEvent<HTMLButtonElement>,
  ) => void;
};

function normalizeContainerKey(containerId: string): string {
  return containerId.trim().toLowerCase();
}

export function DockerContainerListTable({
  items,
  pendingActions,
  sortColumnId,
  sortDirection,
  onSortColumn,
  onOpenAction,
  onLifecycleAction,
}: DockerContainerListTableProps) {
  const { t } = useI18n();

  const columns = useMemo((): DbTablesPanelGridColumn<DockerContainerGridItem>[] => {
    return [
      {
        id: "name",
        sortId: "name",
        header: t("docker.dockPanel.column.name"),
        sortable: true,
        nameCell: true,
        render: (item) => item.container.name || item.container.shortId || item.container.id.slice(0, 12),
        getTitle: (item) => item.container.name || item.container.id,
        getCopyValue: (item) => item.container.name || item.container.id,
      },
      {
        id: "status",
        sortId: "status",
        header: t("docker.dockPanel.column.status"),
        sortable: true,
        render: (item) => {
          const pending = Boolean(pendingActions[normalizeContainerKey(item.container.id)]);
          const phase = getContainerLifecyclePhase(item.container, pending);
          return (
            <span
              className={[
                "docker-container-table__status",
                phase === "running" ? "is-running" : "",
                phase === "transitional" ? "is-transition" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              {lifecycleStatusLabel(item.container, phase, t)}
            </span>
          );
        },
        getTitle: (item) => {
          const pending = Boolean(pendingActions[normalizeContainerKey(item.container.id)]);
          const phase = getContainerLifecyclePhase(item.container, pending);
          return lifecycleStatusLabel(item.container, phase, t);
        },
        copyable: false,
      },
      {
        id: "image",
        sortId: "image",
        header: t("docker.dockPanel.column.image"),
        sortable: true,
        render: (item) => displayValue(item.container.image),
        getTitle: (item) => item.container.image,
        getCopyValue: (item) => item.container.image,
      },
      {
        id: "cpu",
        sortId: "cpu",
        header: t("docker.dockPanel.cpu"),
        sortable: true,
        copyable: false,
        render: (item) => (
          <TableMetricCell value={item.stats?.cpuPercent} running={item.container.running} />
        ),
        getTitle: (item) => formatPercent(item.stats?.cpuPercent, item.container.running),
      },
      {
        id: "memory",
        sortId: "memory",
        header: t("docker.dockPanel.memory"),
        sortable: true,
        copyable: false,
        render: (item) => (
          <TableMetricCell value={item.stats?.memoryPercent} running={item.container.running} />
        ),
        getTitle: (item) => formatPercent(item.stats?.memoryPercent, item.container.running),
      },
      {
        id: "ports",
        header: t("docker.dockPanel.ports"),
        render: (item) => displayValue(formatDockerPorts(item.container)),
        getTitle: (item) => formatDockerPorts(item.container) ?? undefined,
        getCopyValue: (item) => formatDockerPorts(item.container) ?? undefined,
      },
      {
        id: "networks",
        sortId: "networks",
        header: t("docker.dockPanel.networks"),
        sortable: true,
        render: (item) => displayValue(formatDockerNetworks(item.container)),
        getTitle: (item) => formatDockerNetworks(item.container) ?? undefined,
        getCopyValue: (item) => formatDockerNetworks(item.container) ?? undefined,
      },
      {
        id: "actions",
        header: t("docker.dockPanel.column.actions"),
        variant: "actionsSticky",
        copyable: false,
        render: (item) => {
          const pending = Boolean(pendingActions[normalizeContainerKey(item.container.id)]);
          const phase = getContainerLifecyclePhase(item.container, pending);
          const busy = phase === "transitional" || pending;
          return (
            <div className="docker-container-table__actions" onClick={(event) => event.stopPropagation()}>
              <DockerContainerCardStatusControls
                phase={phase}
                busy={pending}
                onAction={(action, event) => onLifecycleAction(item.container, action, event)}
              />
              <Button
                type="button"
                variant="icon"
                size="icon-xs"
                title={t("docker.dockPanel.params")}
                aria-label={t("docker.dockPanel.params")}
                disabled={busy}
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenAction(item.container, "params");
                }}
              >
                <ParamsIcon size={13} />
              </Button>
              <Button
                type="button"
                variant="icon"
                size="icon-xs"
                title={t("docker.dockPanel.logs")}
                aria-label={t("docker.dockPanel.logs")}
                disabled={busy}
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenAction(item.container, "logs");
                }}
              >
                <LogsIcon size={13} />
              </Button>
              <Button
                type="button"
                variant="icon"
                size="icon-xs"
                title={t("docker.dockPanel.directory")}
                aria-label={t("docker.dockPanel.directory")}
                disabled={busy}
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenAction(item.container, "directory");
                }}
              >
                <DirectoryIcon size={13} />
              </Button>
            </div>
          );
        },
      },
    ];
  }, [onLifecycleAction, onOpenAction, pendingActions, t]);

  return (
    <div className="docker-container-table-wrap">
      <DbTablesPanelGrid
        variant="variables"
        className="docker-container-table"
        columns={columns}
        rows={items}
        rowKey={(item) => item.container.id}
        sortColumnId={sortColumnId}
        sortDirection={sortDirection}
        onSortColumn={onSortColumn}
        rowClassName={(item) =>
          item.container.running ? "docker-container-table__row--running" : "docker-container-table__row--stopped"
        }
      />
    </div>
  );
}
