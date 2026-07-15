import { startTransition, useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../../components/ui/Button";
import { IconPlus } from "../../components/ui/Icons";
import { FormDialog, FormField } from "../../components/ui/form/FormDialog";
import { TextInput } from "../../components/ui/form/TextInput";
import { ScopedSearch } from "../../components/ui/search/ScopedSearch";
import { useI18n } from "../../i18n";
import { commands } from "../../ipc/bindings";
import type {
  DockerConnectionInfo,
  DockerContainerSummary,
  DockerNetworkSummary,
} from "../../ipc/bindings";
import { unwrapCommand, unwrapCommandResult } from "../../ipc/result";
import { appConfirm } from "../../lib/appConfirm";
import { showToast } from "../../stores/toastStore";
import { useDockerSidebarCacheStore } from "../../stores/dockerSidebarCacheStore";
import { peekDockerSidebarCache } from "./dockerSidebarCacheSeed";
import { DbTablesPanelGrid, type DbTablesPanelGridColumn } from "../database/workspace/DbTablesPanelGrid";
import { DbPanelMetaRefreshButton } from "../database/workspace/DbPanelMetaRefreshButton";
import {
  containersForNetwork,
  groupContainersByNetworkName,
  networkContainerTagsCopyValue,
} from "./dockerNetworkContainers";
import { dockerContainerMatchesSearch, dockerNetworkMatchesSearch } from "./dockerTreeSearch";
import { containerRowLabel, networkRowLabel } from "./dockerResourceLabels";
import { TrashIcon } from "./icons";

export interface DockerNetworkPanelProps {
  connection: DockerConnectionInfo;
  isActive?: boolean;
}

type SortColumn =
  | "name"
  | "driver"
  | "scope"
  | "created"
  | "containers"
  | "internal"
  | "ipv4Subnet"
  | "ipv4Gateway";
type SortDirection = "asc" | "desc";

interface SortState {
  column: SortColumn;
  direction: SortDirection;
}

const PROTECTED_NETWORKS = new Set(["bridge", "host", "none"]);

async function fetchNetworks(connectionId: string): Promise<DockerNetworkSummary[]> {
  return unwrapCommandResult(await commands.dockerListNetworks(connectionId));
}

async function fetchContainers(connectionId: string): Promise<DockerContainerSummary[]> {
  return unwrapCommandResult(await commands.dockerListContainers(connectionId, null));
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
    case "ipv4Subnet":
      cmp = (a.ipv4Subnet ?? "").localeCompare(b.ipv4Subnet ?? "", undefined, { sensitivity: "base" });
      break;
    case "ipv4Gateway":
      cmp = (a.ipv4Gateway ?? "").localeCompare(b.ipv4Gateway ?? "", undefined, { sensitivity: "base" });
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

function canRemoveNetwork(network: DockerNetworkSummary): boolean {
  return !PROTECTED_NETWORKS.has(network.name.trim().toLowerCase());
}

export function DockerNetworkPanel({ connection, isActive = false }: DockerNetworkPanelProps) {
  const { t } = useI18n();
  const [networks, setNetworks] = useState<DockerNetworkSummary[]>(
    () => peekDockerSidebarCache(connection.connectionId).networks,
  );
  const [containers, setContainers] = useState<DockerContainerSummary[]>(
    () => peekDockerSidebarCache(connection.connectionId).containers,
  );
  const [loading, setLoading] = useState(
    () => peekDockerSidebarCache(connection.connectionId).networks.length === 0,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(
    () => peekDockerSidebarCache(connection.connectionId).error,
  );
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortState>({ column: "name", direction: "asc" });
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createDriver, setCreateDriver] = useState("bridge");
  const [createSubnet, setCreateSubnet] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<Record<string, true>>({});

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
      startTransition(() => {
        setNetworks(nextNetworks);
        setContainers(nextContainers);
      });
      refreshSidebar();
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [connection.connectionId, refreshSidebar]);

  useEffect(() => {
    const cached = peekDockerSidebarCache(connection.connectionId);
    startTransition(() => {
      setNetworks(cached.networks);
      setContainers(cached.containers);
      setError(cached.error);
      setSearch("");
    });
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
      if ((network.ipv4Subnet || "").toLowerCase().includes(query.toLowerCase())) return true;
      if ((network.ipv4Gateway || "").toLowerCase().includes(query.toLowerCase())) return true;
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

  const handleRemove = useCallback(
    (network: DockerNetworkSummary) => {
      if (!canRemoveNetwork(network)) return;
      void (async () => {
        const confirmed = await appConfirm(
          t("docker.networksPanel.removeConfirm", { name: network.name }),
          t("docker.networksPanel.remove"),
          { kind: "warning", confirmLabel: t("common.delete") },
        );
        if (!confirmed) return;
        setPendingRemove((current) => ({ ...current, [network.id]: true }));
        try {
          await unwrapCommand(commands.dockerRemoveNetwork(connection.connectionId, network.name));
          showToast(t("docker.networksPanel.removeSuccess", { name: network.name }));
          await refresh();
        } catch (err) {
          showToast(`${t("docker.networksPanel.removeFailed")}: ${String(err)}`);
        } finally {
          setPendingRemove((current) => {
            if (!current[network.id]) return current;
            const next = { ...current };
            delete next[network.id];
            return next;
          });
        }
      })();
    },
    [connection.connectionId, refresh, t],
  );

  const handlePrune = useCallback(() => {
    void (async () => {
      const confirmed = await appConfirm(
        t("docker.networksPanel.pruneConfirm"),
        t("docker.networksPanel.prune"),
        { kind: "warning", confirmLabel: t("docker.networksPanel.prune") },
      );
      if (!confirmed) return;
      setBusy(true);
      try {
        await unwrapCommand(commands.dockerPruneNetworks(connection.connectionId));
        showToast(t("docker.networksPanel.pruneSuccess"));
        await refresh();
      } catch (err) {
        showToast(`${t("docker.networksPanel.pruneFailed")}: ${String(err)}`);
      } finally {
        setBusy(false);
      }
    })();
  }, [connection.connectionId, refresh, t]);

  const handleCreate = useCallback(() => {
    const name = createName.trim();
    if (!name) {
      setCreateError(t("docker.networksPanel.createNameRequired"));
      return;
    }
    void (async () => {
      setBusy(true);
      setCreateError(null);
      try {
        await unwrapCommand(
          commands.dockerCreateNetwork(connection.connectionId, {
            name,
            driver: createDriver.trim() || null,
            internal: false,
            subnet: createSubnet.trim() || null,
          }),
        );
        showToast(t("docker.networksPanel.createSuccess", { name }));
        setCreateOpen(false);
        setCreateName("");
        setCreateDriver("bridge");
        setCreateSubnet("");
        await refresh();
      } catch (err) {
        setCreateError(String(err));
      } finally {
        setBusy(false);
      }
    })();
  }, [connection.connectionId, createDriver, createName, createSubnet, refresh, t]);

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
        id: "ipv4Subnet",
        sortId: "ipv4Subnet",
        header: t("docker.networksPanel.column.ipv4Subnet"),
        sortable: true,
        render: (network) => network.ipv4Subnet || "—",
        getTitle: (network) => network.ipv4Subnet ?? undefined,
        getCopyValue: (network) => network.ipv4Subnet ?? undefined,
      },
      {
        id: "ipv4Gateway",
        sortId: "ipv4Gateway",
        header: t("docker.networksPanel.column.ipv4Gateway"),
        sortable: true,
        render: (network) => network.ipv4Gateway || "—",
        getTitle: (network) => network.ipv4Gateway ?? undefined,
        getCopyValue: (network) => network.ipv4Gateway ?? undefined,
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
      {
        id: "actions",
        header: t("docker.networksPanel.column.actions"),
        variant: "actionsSticky",
        copyable: false,
        render: (network) => {
          const removable = canRemoveNetwork(network);
          const pending = Boolean(pendingRemove[network.id]);
          return (
            <div className="docker-network-panel__actions" onClick={(event) => event.stopPropagation()}>
              <Button
                type="button"
                variant="icon"
                size="icon-xs"
                title={t("docker.networksPanel.remove")}
                aria-label={t("docker.networksPanel.remove")}
                disabled={!removable || pending || busy}
                onClick={() => handleRemove(network)}
              >
                <TrashIcon />
              </Button>
            </div>
          );
        },
      },
    ];
  }, [busy, containerIndex, handleRemove, pendingRemove, t]);

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
        <div className="docker-network-panel__meta-left">
          <Button
            type="button"
            variant="icon"
            size="icon-xs"
            title={t("docker.networksPanel.create")}
            aria-label={t("docker.networksPanel.create")}
            disabled={loading || busy}
            onClick={() => {
              setCreateError(null);
              setCreateName("");
              setCreateDriver("bridge");
              setCreateSubnet("");
              setCreateOpen(true);
            }}
          >
            <IconPlus size={14} />
          </Button>
          <Button
            type="button"
            variant="icon"
            size="icon-xs"
            title={t("docker.networksPanel.prune")}
            aria-label={t("docker.networksPanel.prune")}
            disabled={loading || busy}
            onClick={handlePrune}
          >
            <TrashIcon />
          </Button>
          <DbPanelMetaRefreshButton onClick={() => void refresh()} disabled={loading || busy} busy={loading} />
          <span className="db-tables-panel-meta-text">
            {loading
              ? t("common.loading")
              : t("docker.networksPanel.count", { count: sortedNetworks.length })}
          </span>
        </div>
      </div>

      <FormDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title={t("docker.networksPanel.create")}
        size="sm"
        clipboardAssist={false}
        cancelDisabled={busy}
        closeDisabled={busy}
        primaryAction={{
          label: busy ? t("common.saving") : t("common.confirm"),
          disabled: busy || !createName.trim(),
          onClick: handleCreate,
        }}
        status={createError ? { kind: "error", message: createError } : null}
      >
        <FormField label={t("docker.networksPanel.createName")}>
          <TextInput
            value={createName}
            onChange={setCreateName}
            placeholder={t("docker.networksPanel.createNamePlaceholder")}
            disabled={busy}
          />
        </FormField>
        <FormField label={t("docker.networksPanel.createDriver")}>
          <TextInput
            value={createDriver}
            onChange={setCreateDriver}
            placeholder="bridge"
            disabled={busy}
          />
        </FormField>
        <FormField label={t("docker.networksPanel.createSubnet")} hint={t("docker.networksPanel.createSubnetHint")}>
          <TextInput
            value={createSubnet}
            onChange={setCreateSubnet}
            placeholder="172.28.0.0/16"
            disabled={busy}
          />
        </FormField>
      </FormDialog>
    </ScopedSearch>
  );
}
