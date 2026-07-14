import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { IconChevronDown } from "../../components/ui/Icons";
import { ScopedSearch } from "../../components/ui/search/ScopedSearch";
import { useI18n } from "../../i18n";
import { commands } from "../../ipc/bindings";
import type { DockerConnectionInfo, DockerContainerSummary } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { sidebarTreeSearchMatches } from "@/lib/sidebarTreeSearch";
import { useDockerSidebarCacheStore } from "../../stores/dockerSidebarCacheStore";
import type { DbTablesPanelGridColumn } from "../database/workspace/DbTablesPanelGrid";
import { DbPanelMetaRefreshButton } from "../database/workspace/DbPanelMetaRefreshButton";
import {
  groupContainersByComposeProject,
  resolveComposeProjectName,
} from "./dockerComposeGroups";
import { formatDockerNetworks, formatDockerPorts } from "./dockerContainerCardFormat";
import { dockerContainerMatchesSearch } from "./dockerTreeSearch";
import { containerRowLabel } from "./dockerResourceLabels";
import { ComposeStackIcon } from "./icons";

export interface DockerContainerPanelProps {
  connection: DockerConnectionInfo;
  /** 当前 Tab 是否处于激活态；激活时自动拉取容器列表。 */
  isActive?: boolean;
}

type SortColumn = "name" | "status" | "image" | "created" | "ports" | "networks";
type SortDirection = "asc" | "desc";

interface SortState {
  column: SortColumn;
  direction: SortDirection;
}

async function fetchContainers(connectionId: string): Promise<DockerContainerSummary[]> {
  return unwrapCommand(commands.dockerListContainers(connectionId, null));
}

function formatCreatedAt(ts: number | null | undefined): string {
  if (ts == null || !Number.isFinite(ts) || ts <= 0) return "—";
  const ms = ts < 1e12 ? ts * 1000 : ts;
  return new Date(ms).toLocaleString();
}

function containerStatusLabel(container: DockerContainerSummary): string {
  return container.statusText?.trim() || container.state?.trim() || "—";
}

function compareContainers(
  a: DockerContainerSummary,
  b: DockerContainerSummary,
  column: SortColumn,
  direction: SortDirection,
): number {
  let cmp = 0;
  switch (column) {
    case "name":
      cmp = containerRowLabel(a).localeCompare(containerRowLabel(b), undefined, {
        sensitivity: "base",
        numeric: true,
      });
      break;
    case "status":
      cmp = Number(b.running) - Number(a.running);
      if (cmp === 0) {
        cmp = containerStatusLabel(a).localeCompare(containerStatusLabel(b), undefined, {
          sensitivity: "base",
        });
      }
      break;
    case "image":
      cmp = (a.image || "").localeCompare(b.image || "", undefined, {
        sensitivity: "base",
        numeric: true,
      });
      break;
    case "created":
      cmp = (a.createdAt ?? 0) - (b.createdAt ?? 0);
      break;
    case "ports":
      cmp = (formatDockerPorts(a) || "").localeCompare(formatDockerPorts(b) || "", undefined, {
        sensitivity: "base",
      });
      break;
    case "networks":
      cmp = (formatDockerNetworks(a) || "").localeCompare(formatDockerNetworks(b) || "", undefined, {
        sensitivity: "base",
      });
      break;
  }
  return direction === "asc" ? cmp : -cmp;
}

function sortContainers(
  items: DockerContainerSummary[],
  column: SortColumn,
  direction: SortDirection,
): DockerContainerSummary[] {
  const sorted = [...items];
  sorted.sort((a, b) => compareContainers(a, b, column, direction));
  return sorted;
}

function headerCellClassName(
  column: DbTablesPanelGridColumn<DockerContainerSummary>,
  sortColumnId: string,
  sortDirection: SortDirection,
): string {
  const sortId = column.sortId ?? column.id;
  const classes: string[] = [];
  if (column.nameCell) classes.push("db-tables-panel-grid__name-col");
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

export function DockerContainerPanel({ connection, isActive = false }: DockerContainerPanelProps) {
  const { t } = useI18n();
  const [containers, setContainers] = useState<DockerContainerSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortState>({ column: "name", direction: "asc" });
  /** 折叠中的 Compose 项目名；未列出则默认展开 */
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set());

  const refreshSidebarContainers = useCallback(() => {
    void useDockerSidebarCacheStore
      .getState()
      .refreshScope({ kind: "category", connectionId: connection.connectionId, category: "containers" });
  }, [connection.connectionId]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await fetchContainers(connection.connectionId);
      setContainers(next);
      refreshSidebarContainers();
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [connection.connectionId, refreshSidebarContainers]);

  useEffect(() => {
    setContainers([]);
    setError(null);
    setSearch("");
    setCollapsedProjects(new Set());
  }, [connection.connectionId]);

  useEffect(() => {
    if (!isActive) return;
    void refresh();
  }, [isActive, refresh]);

  const toggleSort = useCallback((columnId: string) => {
    const column = columnId as SortColumn;
    setSort((prev) =>
      prev.column === column
        ? { column, direction: prev.direction === "asc" ? "desc" : "asc" }
        : { column, direction: "asc" },
    );
  }, []);

  const toggleProject = useCallback((project: string) => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(project)) next.delete(project);
      else next.add(project);
      return next;
    });
  }, []);

  const filteredContainers = useMemo(() => {
    const query = search.trim();
    if (!query) return containers;
    return containers.filter((container) => {
      const project = resolveComposeProjectName(container);
      if (project && sidebarTreeSearchMatches(query, project)) return true;
      return (
        dockerContainerMatchesSearch(query, container) ||
        (formatDockerPorts(container) || "").toLowerCase().includes(query.toLowerCase()) ||
        (formatDockerNetworks(container) || "").toLowerCase().includes(query.toLowerCase())
      );
    });
  }, [containers, search]);

  const composeGroups = useMemo(() => {
    const groups = groupContainersByComposeProject(
      filteredContainers.filter((container) => resolveComposeProjectName(container) != null),
    );
    return groups.map((group) => ({
      project: group.project,
      containers: sortContainers(group.containers, sort.column, sort.direction),
    }));
  }, [filteredContainers, sort.column, sort.direction]);

  const standaloneContainers = useMemo(
    () =>
      sortContainers(
        filteredContainers.filter((container) => resolveComposeProjectName(container) == null),
        sort.column,
        sort.direction,
      ),
    [filteredContainers, sort.column, sort.direction],
  );

  const hasComposeGroups = composeGroups.length > 0;

  const gridColumns = useMemo((): DbTablesPanelGridColumn<DockerContainerSummary>[] => {
    return [
      {
        id: "name",
        sortId: "name",
        header: t("docker.containersPanel.column.name"),
        sortable: true,
        nameCell: true,
        render: (container) => containerRowLabel(container),
        getTitle: (container) => containerRowLabel(container),
        getCopyValue: (container) => containerRowLabel(container),
      },
      {
        id: "id",
        header: t("docker.containersPanel.column.id"),
        render: (container) => container.shortId || container.id.slice(0, 12) || "—",
        getTitle: (container) => container.id,
        getCopyValue: (container) => container.id,
      },
      {
        id: "status",
        sortId: "status",
        header: t("docker.containersPanel.column.status"),
        sortable: true,
        render: (container) => (
          <span
            className={`docker-container-panel__status${
              container.running ? " docker-container-panel__status--running" : ""
            }`}
          >
            {containerStatusLabel(container)}
          </span>
        ),
        getTitle: (container) => containerStatusLabel(container),
        getCopyValue: (container) => containerStatusLabel(container),
      },
      {
        id: "image",
        sortId: "image",
        header: t("docker.containersPanel.column.image"),
        sortable: true,
        render: (container) => container.image || "—",
        getTitle: (container) => container.image || "—",
        getCopyValue: (container) => container.image || "",
      },
      {
        id: "ports",
        sortId: "ports",
        header: t("docker.containersPanel.column.ports"),
        sortable: true,
        render: (container) => formatDockerPorts(container) || "—",
        getTitle: (container) => formatDockerPorts(container) || "—",
        getCopyValue: (container) => formatDockerPorts(container) || "",
      },
      {
        id: "networks",
        sortId: "networks",
        header: t("docker.containersPanel.column.networks"),
        sortable: true,
        render: (container) => formatDockerNetworks(container) || "—",
        getTitle: (container) => formatDockerNetworks(container) || "—",
        getCopyValue: (container) => formatDockerNetworks(container) || "",
      },
      {
        id: "created",
        sortId: "created",
        header: t("docker.containersPanel.column.created"),
        sortable: true,
        render: (container) => formatCreatedAt(container.createdAt),
        getTitle: (container) => formatCreatedAt(container.createdAt),
      },
    ];
  }, [t]);

  const renderContainerRow = (container: DockerContainerSummary, nested: boolean): ReactNode => (
    <tr
      key={container.id}
      className={nested ? "docker-container-panel__nested-row" : undefined}
    >
      {gridColumns.map((column) => (
        <td
          key={column.id}
          className={
            column.nameCell
              ? nested
                ? "db-tables-panel-grid__name docker-container-panel__nested-name"
                : "db-tables-panel-grid__name"
              : undefined
          }
          title={column.getTitle?.(container)}
        >
          {column.render(container, 0)}
        </td>
      ))}
    </tr>
  );

  const renderTable = () => {
    if (loading && containers.length === 0) {
      return <div className="db-tables-panel-empty">{t("common.loading")}</div>;
    }
    if (error && containers.length === 0) {
      return <div className="db-tables-panel-error">{error}</div>;
    }
    if (containers.length === 0) {
      return <div className="db-tables-panel-empty">{t("docker.containersPanel.empty")}</div>;
    }
    if (filteredContainers.length === 0) {
      return <div className="db-tables-panel-empty">{t("docker.containersPanel.noResults")}</div>;
    }

    return (
      <div className="db-tables-panel-grid-host" tabIndex={-1}>
        <table className="db-tables-panel-grid db-tables-panel-grid--variables">
          <thead>
            <tr>
              {gridColumns.map((column) => {
                const sortId = column.sortId ?? column.id;
                const sortable = Boolean(column.sortable);
                return (
                  <th
                    key={column.id}
                    className={headerCellClassName(column, sort.column, sort.direction)}
                    onClick={sortable ? () => toggleSort(sortId) : undefined}
                    aria-sort={
                      sortable && sort.column === sortId
                        ? sort.direction === "asc"
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                  >
                    {sortable ? (
                      <span className="db-tables-panel-grid__th-label">
                        {column.header}
                        {sort.column === sortId ? (
                          <span className="db-tables-panel-grid__sort-mark" aria-hidden>
                            {sort.direction === "asc" ? "↑" : "↓"}
                          </span>
                        ) : null}
                      </span>
                    ) : (
                      column.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {composeGroups.map((group) => {
              const expanded = !collapsedProjects.has(group.project);
              const runningCount = group.containers.filter((c) => c.running).length;
              return (
                <Fragment key={`compose:${group.project}`}>
                  <tr
                    className="docker-container-panel__group-row"
                    onClick={() => toggleProject(group.project)}
                  >
                    <td colSpan={gridColumns.length}>
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
                            count: group.containers.length,
                            running: runningCount,
                          })}
                        </span>
                      </button>
                    </td>
                  </tr>
                  {expanded
                    ? group.containers.map((container) => renderContainerRow(container, true))
                    : null}
                </Fragment>
              );
            })}

            {hasComposeGroups && standaloneContainers.length > 0 ? (
              <tr className="docker-container-panel__group-row docker-container-panel__group-row--standalone">
                <td colSpan={gridColumns.length}>
                  <span className="docker-container-panel__group-toggle docker-container-panel__group-toggle--static">
                    <span className="docker-container-panel__group-title">
                      {t("docker.containersPanel.standalone")}
                    </span>
                    <span className="docker-container-panel__group-meta">
                      {t("docker.containersPanel.count", { count: standaloneContainers.length })}
                    </span>
                  </span>
                </td>
              </tr>
            ) : null}

            {standaloneContainers.map((container) =>
              renderContainerRow(container, hasComposeGroups),
            )}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <ScopedSearch
      className="db-tables-panel db-tables-panel--dock docker-container-panel"
      value={search}
      onChange={setSearch}
      placeholder={t("docker.containersPanel.search")}
      enabled
    >
      <div className="db-tables-panel-body">
        <div className="db-tables-panel-grid-wrap">{renderTable()}</div>
      </div>
      <div className="db-tables-panel-meta">
        <div className="docker-container-panel__meta-left">
          <DbPanelMetaRefreshButton onClick={() => void refresh()} disabled={loading} busy={loading} />
          <span className="db-tables-panel-meta-text">
            {loading
              ? t("common.loading")
              : t("docker.containersPanel.count", { count: filteredContainers.length })}
          </span>
        </div>
      </div>
    </ScopedSearch>
  );
}
