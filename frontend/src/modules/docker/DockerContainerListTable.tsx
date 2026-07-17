import { Fragment, useCallback, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import {
  type DbTablesPanelGridColumn,
  type DbTablesPanelGridSortDirection,
} from "../database/workspace/DbTablesPanelGrid";
import { Button } from "../../components/ui/Button";
import { IconChevronDown, IconCopy } from "../../components/ui/Icons";
import {
  useResizableTableColumns,
  type ResizableColumnDef,
} from "../../components/ui/table/useResizableTableColumns";
import { useI18n } from "../../i18n";
import type { DockerContainerSummary } from "../../ipc/bindings";
import { showToast } from "../../stores/toastStore";
import { resolveComposeProjectName } from "./dockerComposeGroups";
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
import { ComposeStackIcon, DirectoryIcon, LogsIcon, ParamsIcon } from "./icons";
import type { DockerContainerSubWindowKind } from "./DockerDockPanel";

async function writeToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.left = "-9999px";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(area);
      return ok;
    } catch {
      return false;
    }
  }
}

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
  // 未运行，或尚未拉到 stats：显示占位，避免把「无数据」误显示成 0%
  if (!running || value == null || Number.isNaN(value)) {
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

/** 按 Compose 项目分组；组内顺序沿用外部已排序的 items。 */
function partitionComposeItems(items: DockerContainerGridItem[]): {
  composeGroups: Array<{ project: string; items: DockerContainerGridItem[] }>;
  standalone: DockerContainerGridItem[];
} {
  const groupMap = new Map<string, DockerContainerGridItem[]>();
  const standalone: DockerContainerGridItem[] = [];
  for (const item of items) {
    const project = resolveComposeProjectName(item.container);
    if (!project) {
      standalone.push(item);
      continue;
    }
    const bucket = groupMap.get(project);
    if (bucket) bucket.push(item);
    else groupMap.set(project, [item]);
  }
  const composeGroups = [...groupMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }))
    .map(([project, groupItems]) => ({ project, items: groupItems }));
  return { composeGroups, standalone };
}

function headerCellClassName(
  column: DbTablesPanelGridColumn<DockerContainerGridItem>,
  sortColumnId: string,
  sortDirection: DbTablesPanelGridSortDirection,
): string {
  const sortId = column.sortId ?? column.id;
  const classes: string[] = [];
  if (column.nameCell) classes.push("db-tables-panel-grid__name-col");
  if (column.variant === "actions" || column.variant === "actionsSticky") {
    classes.push("db-tables-panel-grid__actions-col");
  }
  if (column.variant === "actionsSticky") {
    classes.push("db-tables-panel-grid__actions-col--sticky");
  }
  if (column.sortable) {
    if (sortColumnId === sortId) {
      classes.push(
        sortDirection === "asc"
          ? "db-tables-panel-grid__sortable db-tables-panel-grid__sort-asc"
          : "db-tables-panel-grid__sortable db-tables-panel-grid__sort-desc",
      );
    } else {
      classes.push("db-tables-panel-grid__sortable");
    }
  }
  return classes.filter(Boolean).join(" ");
}

function bodyCellClassName(
  column: DbTablesPanelGridColumn<DockerContainerGridItem>,
  nested: boolean,
): string | undefined {
  const classes: string[] = [];
  if (column.nameCell) {
    classes.push("db-tables-panel-grid__name");
    if (nested) classes.push("docker-container-panel__nested-name");
  }
  if (column.variant === "actions" || column.variant === "actionsSticky") {
    classes.push("db-tables-panel-grid__actions-col");
  }
  if (column.variant === "actionsSticky") {
    classes.push("db-tables-panel-grid__actions-col--sticky");
  }
  return classes.length > 0 ? classes.join(" ") : undefined;
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
  /** 折叠中的 Compose 项目名；未列出则默认展开 */
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set());

  const columns = useMemo((): DbTablesPanelGridColumn<DockerContainerGridItem>[] => {
    return [
      {
        id: "name",
        sortId: "name",
        header: t("docker.dockPanel.column.name"),
        sortable: true,
        nameCell: true,
        copyable: false,
        defaultWidth: 180,
        minWidth: 120,
        render: (item) => {
          const name =
            item.container.name || item.container.shortId || item.container.id.slice(0, 12);
          const containerId = item.container.id;
          return (
            <div className="docker-container-table__name-cell">
              <span className="docker-container-table__name-text" title={name}>
                {name}
              </span>
              <Button
                type="button"
                variant="icon"
                size="icon-xs"
                className="docker-container-table__copy-id"
                title={t("docker.dockPanel.copyContainerId")}
                aria-label={t("docker.dockPanel.copyContainerId")}
                onClick={(event) => {
                  event.stopPropagation();
                  void writeToClipboard(containerId).then((ok) => {
                    if (ok) showToast(t("common.copied"));
                  });
                }}
              >
                <IconCopy size={12} />
              </Button>
            </div>
          );
        },
        getTitle: (item) => item.container.name || item.container.id,
      },
      {
        id: "status",
        sortId: "status",
        header: t("docker.dockPanel.column.status"),
        sortable: true,
        defaultWidth: 168,
        minWidth: 120,
        render: (item) => {
          const pending = Boolean(pendingActions[normalizeContainerKey(item.container.id)]);
          const phase = getContainerLifecyclePhase(item.container, pending);
          return (
            <div
              className="docker-container-table__status-cell"
              onClick={(event) => event.stopPropagation()}
            >
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
              <DockerContainerCardStatusControls
                phase={phase}
                busy={pending}
                onAction={(action, event) => onLifecycleAction(item.container, action, event)}
              />
            </div>
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
        defaultWidth: 180,
        minWidth: 96,
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
        defaultWidth: 96,
        minWidth: 72,
        render: (item) => (
          <TableMetricCell
            value={item.stats == null ? null : item.stats.cpuPercent}
            running={item.container.running}
          />
        ),
        getTitle: (item) =>
          item.stats == null
            ? "—"
            : formatPercent(item.stats.cpuPercent, item.container.running),
      },
      {
        id: "memory",
        sortId: "memory",
        header: t("docker.dockPanel.memory"),
        sortable: true,
        copyable: false,
        defaultWidth: 96,
        minWidth: 72,
        render: (item) => (
          <TableMetricCell
            value={item.stats == null ? null : item.stats.memoryPercent}
            running={item.container.running}
          />
        ),
        getTitle: (item) =>
          item.stats == null
            ? "—"
            : formatPercent(item.stats.memoryPercent, item.container.running),
      },
      {
        id: "ports",
        header: t("docker.dockPanel.ports"),
        defaultWidth: 140,
        minWidth: 80,
        render: (item) => displayValue(formatDockerPorts(item.container)),
        getTitle: (item) => formatDockerPorts(item.container) ?? undefined,
        getCopyValue: (item) => formatDockerPorts(item.container) ?? undefined,
      },
      {
        id: "networks",
        sortId: "networks",
        header: t("docker.dockPanel.networks"),
        sortable: true,
        defaultWidth: 120,
        minWidth: 80,
        render: (item) => displayValue(formatDockerNetworks(item.container)),
        getTitle: (item) => formatDockerNetworks(item.container) ?? undefined,
        getCopyValue: (item) => formatDockerNetworks(item.container) ?? undefined,
      },
      {
        id: "actions",
        header: t("docker.dockPanel.column.actions"),
        variant: "actionsSticky",
        copyable: false,
        resizable: false,
        defaultWidth: 96,
        minWidth: 96,
        render: (item) => {
          const pending = Boolean(pendingActions[normalizeContainerKey(item.container.id)]);
          const phase = getContainerLifecyclePhase(item.container, pending);
          const busy = phase === "transitional" || pending;
          return (
            <div className="docker-container-table__actions" onClick={(event) => event.stopPropagation()}>
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

  const { composeGroups, standalone } = useMemo(() => partitionComposeItems(items), [items]);
  const hasComposeGroups = composeGroups.length > 0;

  const resizeColumnDefs = useMemo((): ResizableColumnDef[] => {
    return columns.map((column) => {
      const action = column.variant === "actions" || column.variant === "actionsSticky";
      return {
        id: column.id,
        defaultWidth: column.defaultWidth ?? (action ? 96 : 120),
        minWidth: column.minWidth ?? (action ? 48 : 64),
        resizable: column.resizable ?? !action,
      };
    });
  }, [columns]);

  const { tableRef, getColumnStyle, startColumnResize, isColumnResizable } = useResizableTableColumns(
    resizeColumnDefs,
    {
      storageKey: "omnipanel.docker.containers.column-widths.v1",
      constrainMaxWidth: false,
    },
  );

  const toggleProject = useCallback((project: string) => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(project)) next.delete(project);
      else next.add(project);
      return next;
    });
  }, []);

  const renderContainerRow = (item: DockerContainerGridItem, nested: boolean): ReactNode => (
    <tr
      key={item.container.id}
      className={[
        nested ? "docker-container-panel__nested-row" : "",
        item.container.running
          ? "docker-container-table__row--running"
          : "docker-container-table__row--stopped",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {columns.map((column, columnIndex) => (
        <td
          key={column.id}
          data-col-id={column.id}
          className={bodyCellClassName(column, nested)}
          style={getColumnStyle(column.id)}
          title={column.getTitle?.(item)}
        >
          {column.render(item, columnIndex)}
        </td>
      ))}
    </tr>
  );

  return (
    <div className="docker-container-table-wrap">
      <div className="db-tables-panel-grid-host" tabIndex={-1}>
        <table
          ref={tableRef}
          className="db-tables-panel-grid db-tables-panel-grid--variables db-tables-panel-grid--resizable docker-container-table"
        >
          <thead>
            <tr>
              {columns.map((column) => {
                const sortId = column.sortId ?? column.id;
                const sortable = Boolean(column.sortable);
                const resizable = isColumnResizable(column.id);
                return (
                  <th
                    key={column.id}
                    data-col-id={column.id}
                    className={headerCellClassName(column, sortColumnId, sortDirection)}
                    style={getColumnStyle(column.id)}
                    onClick={sortable ? () => onSortColumn(sortId) : undefined}
                    aria-sort={
                      sortable && sortColumnId === sortId
                        ? sortDirection === "asc"
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                  >
                    {sortable ? (
                      <span className="db-tables-panel-grid__th-label">
                        {column.header}
                        {sortColumnId === sortId ? (
                          <span className="db-tables-panel-grid__sort-mark" aria-hidden>
                            {sortDirection === "asc" ? "↑" : "↓"}
                          </span>
                        ) : null}
                      </span>
                    ) : (
                      column.header
                    )}
                    {resizable ? (
                      <div
                        className="db-tables-panel-grid__col-resize"
                        onMouseDown={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          startColumnResize(column.id, event.clientX);
                        }}
                        onClick={(event) => event.stopPropagation()}
                      />
                    ) : null}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {composeGroups.map((group) => {
              const expanded = !collapsedProjects.has(group.project);
              const runningCount = group.items.filter((item) => item.container.running).length;
              return (
                <Fragment key={`compose:${group.project}`}>
                  <tr
                    className="docker-container-panel__group-row"
                    onClick={() => toggleProject(group.project)}
                  >
                    <td colSpan={columns.length}>
                      <button
                        type="button"
                        className="docker-container-panel__group-toggle"
                        aria-expanded={expanded}
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleProject(group.project);
                        }}
                      >
                        <IconChevronDown
                          size={14}
                          className={`docker-container-panel__group-chevron${
                            expanded ? "" : " docker-container-panel__group-chevron--collapsed"
                          }`}
                        />
                        <ComposeStackIcon size={14} />
                        <span className="docker-container-panel__group-title">{group.project}</span>
                        <span className="docker-container-panel__group-meta">
                          {t("docker.containersPanel.composeCount", {
                            count: group.items.length,
                            running: runningCount,
                          })}
                        </span>
                      </button>
                    </td>
                  </tr>
                  {expanded ? group.items.map((item) => renderContainerRow(item, true)) : null}
                </Fragment>
              );
            })}

            {hasComposeGroups && standalone.length > 0 ? (
              <tr className="docker-container-panel__group-row docker-container-panel__group-row--standalone">
                <td colSpan={columns.length}>
                  <span className="docker-container-panel__group-toggle docker-container-panel__group-toggle--static">
                    <span className="docker-container-panel__group-title">
                      {t("docker.containersPanel.standalone")}
                    </span>
                    <span className="docker-container-panel__group-meta">
                      {t("docker.containersPanel.count", { count: standalone.length })}
                    </span>
                  </span>
                </td>
              </tr>
            ) : null}

            {standalone.map((item) => renderContainerRow(item, hasComposeGroups))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
