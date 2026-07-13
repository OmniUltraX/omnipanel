import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "../../i18n";
import { ScopedSearch } from "../../components/ui/search/ScopedSearch";
import { commands } from "../../ipc/bindings";
import type {
  DockerConnectionInfo,
  DockerContainerSummary,
  DockerNetworkSummary,
} from "../../ipc/bindings";
import { useDockerSidebarCacheStore } from "../../stores/dockerSidebarCacheStore";
import { DbTablesPanelGrid, type DbTablesPanelGridColumn } from "../database/workspace/DbTablesPanelGrid";
import { DbPanelMetaRefreshButton } from "../database/workspace/DbPanelMetaRefreshButton";
import {
  containersForNetwork,
  groupContainersByNetworkName,
  networkContainerTagsCopyValue,
} from "./dockerNetworkContainers";
import { dockerContainerMatchesSearch, dockerNetworkMatchesSearch } from "./dockerTreeSearch";
import { containerRowLabel, networkRowLabel } from "./dockerResourceLabels";

export interface DockerNetworkPanelProps {
  connection: DockerConnectionInfo;
  isActive?: boolean;
}

type SortColumn = "name" | "driver" | "scope" | "created" | "containers" | "internal";
type SortDirection = "asc" | "desc";

interface SortState {
  column: SortColumn;
  direction: SortDirection;
}

async function fetchNetworks(connectionId: string): Promise<DockerNetworkSummary[]> {
  const res = await commands.dockerListNetworks(connectionId);
  if (res.status === "ok") return res.data;
  throw new Error(res.error.message);
}

async function fetchContainers(connectionId: string): Promise<DockerContainerSummary[]> {
  const res = await commands.dockerListContainers(connectionId, null);
  if (res.status === "ok") return res.data;
  throw new Error(res.error.message);
}

function formatCreatedAt(ts: number | null): string {
  if (ts == null || !Number.isFinite(ts) || ts <= 0) return "—";
  const ms = ts < 1e12 ? ts * 1000 : ts;
  return new Date(ms).toLocaleString();
}

function compareNetworks(
  a: DockerNetworkSummary,
  b: DockerNetworkSummary,
  column: SortColumn,
  direction: SortDirection,
  containerIndex: Map<string, DockerContainerSummary[]>,
): number {
  let cmp = 0;
  switch (column) {
    case "name":
      cmp = networkRowLabel(a).localeCompare(networkRowLabel(b), undefined, {
        sensitivity: "base",
        numeric: true,
      });
      break;
    case "driver":
      cmp = (a.driver ?? "").localeCompare(b.driver ?? "", undefined, { sensitivity: "base" });
      break;
    case "scope":
      cmp = (a.scope ?? "").localeCompare(b.scope ?? "", undefined, { sensitivity: "base" });
      break;
    case "created":
      cmp = (a.createdAt ?? 0) - (b.createdAt ?? 0);
      break;
    case "containers":
      cmp =
        containersForNetwork(a, containerIndex).length -
        containersForNetwork(b, containerIndex).length;
      break;
    case "internal":
      cmp = Number(a.internal) - Number(b.internal);
      break;
  }
  return direction === "asc" ? cmp : -cmp;
}

function NetworkContainerTags({ containers }: { containers: DockerContainerSummary[] }) {
  if (containers.length === 0) {
    return <span className="docker-network-panel__container-tags-empty">—</span>;
  }

  return (
    <span className="docker-network-panel__container-tags">
      {containers.map((container) => {
        const label = containerRowLabel(container);
        return (
          <span
            key={container.id}
            className={`tag docker-network-panel__container-tag${
              container.running ? " docker-network-panel__container-tag--running" : ""
            }`}
            title={label}
          >
            {label}
          </span>
        );
      })}
    </span>
  );
}

export function DockerNetworkPanel({ connection, isActive = false }: DockerNetworkPanelProps) {
  const { t } = useI18n();
  const [networks, setNetworks] = useState<DockerNetworkSummary[]>([]);
  const [containers, setContainers] = useState<DockerContainerSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortState>({ column: "name", direction: "asc" });

  const refreshSidebar = useCallback(() => {
    void useDockerSidebarCacheStore
      .getState()
      .refreshScope({ kind: "category", connectionId: connection.connectionId, category: "networks" });
    void useDockerSidebarCacheStore
      .getState()
      .refreshScope({ kind: "category", connectionId: connection.connectionId, category: "containers" });
  }, [connection.connectionId]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextNetworks, nextContainers] = await Promise.all([
        fetchNetworks(connection.connectionId),
        fetchContainers(connection.connectionId),
      ]);
      setNetworks(nextNetworks);
      setContainers(nextContainers);
      refreshSidebar();
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [connection.connectionId, refreshSidebar]);

  useEffect(() => {
    setNetworks([]);
    setContainers([]);
    setError(null);
    setSearch("");
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

  const containerIndex = useMemo(
    () => groupContainersByNetworkName(networks, containers),
    [containers, networks],
  );

  const filteredNetworks = useMemo(() => {
    const query = search.trim();
    if (!query) return networks;
    return networks.filter((network) => {
      if (dockerNetworkMatchesSearch(query, network)) return true;
      return containersForNetwork(network, containerIndex).some((container) =>
        dockerContainerMatchesSearch(query, container),
      );
    });
  }, [containerIndex, networks, search]);

  const sortedNetworks = useMemo(() => {
    const sorted = [...filteredNetworks];
    sorted.sort((a, b) => compareNetworks(a, b, sort.column, sort.direction, containerIndex));
    return sorted;
  }, [containerIndex, filteredNetworks, sort.column, sort.direction]);

  const gridColumns = useMemo((): DbTablesPanelGridColumn<DockerNetworkSummary>[] => {
    return [
      {
        id: "name",
        sortId: "name",
        header: t("docker.networksPanel.column.name"),
        sortable: true,
        nameCell: true,
        render: (network) => networkRowLabel(network),
        getTitle: (network) => networkRowLabel(network),
        getCopyValue: (network) => networkRowLabel(network),
      },
      {
        id: "id",
        header: t("docker.networksPanel.column.id"),
        render: (network) => network.id.slice(0, 12) || "—",
        getTitle: (network) => network.id,
        getCopyValue: (network) => network.id,
      },
      {
        id: "driver",
        sortId: "driver",
        header: t("docker.networksPanel.column.driver"),
        sortable: true,
        render: (network) => network.driver || "—",
        getTitle: (network) => network.driver,
        getCopyValue: (network) => network.driver,
      },
      {
        id: "scope",
        sortId: "scope",
        header: t("docker.networksPanel.column.scope"),
        sortable: true,
        render: (network) => network.scope || "—",
        getTitle: (network) => network.scope,
        getCopyValue: (network) => network.scope,
      },
      {
        id: "internal",
        sortId: "internal",
        header: t("docker.networksPanel.column.internal"),
        sortable: true,
        render: (network) =>
          network.internal
            ? t("docker.networksPanel.internalYes")
            : t("docker.networksPanel.internalNo"),
        getTitle: (network) =>
          network.internal
            ? t("docker.networksPanel.internalYes")
            : t("docker.networksPanel.internalNo"),
      },
      {
        id: "created",
        sortId: "created",
        header: t("docker.networksPanel.column.created"),
        sortable: true,
        render: (network) => formatCreatedAt(network.createdAt),
        getTitle: (network) => formatCreatedAt(network.createdAt),
      },
      {
        id: "containers",
        sortId: "containers",
        header: t("docker.networksPanel.column.containers"),
        sortable: true,
        render: (network) => (
          <NetworkContainerTags containers={containersForNetwork(network, containerIndex)} />
        ),
        getTitle: (network) =>
          networkContainerTagsCopyValue(containersForNetwork(network, containerIndex)),
        getCopyValue: (network) =>
          networkContainerTagsCopyValue(containersForNetwork(network, containerIndex)),
      },
    ];
  }, [containerIndex, t]);

  const renderTable = () => {
    if (loading && networks.length === 0) {
      return <div className="db-tables-panel-empty">{t("common.loading")}</div>;
    }
    if (error && networks.length === 0) {
      return <div className="db-tables-panel-error">{error}</div>;
    }
    if (networks.length === 0) {
      return <div className="db-tables-panel-empty">{t("docker.networksPanel.empty")}</div>;
    }
    if (sortedNetworks.length === 0) {
      return <div className="db-tables-panel-empty">{t("docker.networksPanel.noResults")}</div>;
    }

    return (
      <DbTablesPanelGrid
        variant="variables"
        columns={gridColumns}
        rows={sortedNetworks}
        rowKey={(network) => network.id}
        sortColumnId={sort.column}
        sortDirection={sort.direction}
        onSortColumn={toggleSort}
      />
    );
  };

  return (
    <ScopedSearch
      className="db-tables-panel db-tables-panel--dock docker-network-panel"
      value={search}
      onChange={setSearch}
      placeholder={t("docker.networksPanel.search")}
      enabled
    >
      <div className="db-tables-panel-body">
        <div className="db-tables-panel-grid-wrap">{renderTable()}</div>
      </div>
      <div className="db-tables-panel-meta">
        <DbPanelMetaRefreshButton onClick={() => void refresh()} disabled={loading} busy={loading} />
        <span className="db-tables-panel-meta-text">
          {loading
            ? t("common.loading")
            : t("docker.networksPanel.count", { count: sortedNetworks.length })}
        </span>
      </div>
    </ScopedSearch>
  );
}
