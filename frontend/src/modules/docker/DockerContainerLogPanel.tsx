import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../../components/ui/Button";
import { ScopedSearch } from "../../components/ui/search/ScopedSearch";
import { useI18n } from "../../i18n";
import { commands, type DockerConnectionInfo, type DockerContainerLogInfo } from "../../ipc/bindings";
import { appConfirm } from "../../lib/appConfirm";
import { showToast } from "../../stores/toastStore";
import { DbPanelMetaRefreshButton } from "../database/workspace/DbPanelMetaRefreshButton";
import { DbTablesPanelGrid, type DbTablesPanelGridColumn } from "../database/workspace/DbTablesPanelGrid";
import { TrashIcon } from "./icons";

export interface DockerContainerLogPanelProps {
  connection: DockerConnectionInfo;
  isActive?: boolean;
}

type SortColumn = "name" | "size" | "path";
type SortDirection = "asc" | "desc";

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function displayName(info: DockerContainerLogInfo): string {
  const name = info.name?.trim();
  if (name) return name.replace(/^\//, "");
  return info.containerId.slice(0, 12);
}

async function fetchLogInfos(connectionId: string): Promise<DockerContainerLogInfo[]> {
  const res = await commands.dockerListContainerLogInfos(connectionId);
  if (res.status === "ok") return res.data;
  throw new Error(res.error.message);
}

export function DockerContainerLogPanel({
  connection,
  isActive = false,
}: DockerContainerLogPanelProps) {
  const { t } = useI18n();
  const [rows, setRows] = useState<DockerContainerLogInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [pendingIds, setPendingIds] = useState<Record<string, true>>({});
  const [sort, setSort] = useState<{ column: SortColumn; direction: SortDirection }>({
    column: "size",
    direction: "desc",
  });

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await fetchLogInfos(connection.connectionId));
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [connection.connectionId]);

  useEffect(() => {
    setRows([]);
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
        : { column, direction: column === "size" ? "desc" : "asc" },
    );
  }, []);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return rows;
    return rows.filter((row) => {
      const name = displayName(row).toLowerCase();
      return (
        name.includes(query) ||
        row.containerId.toLowerCase().includes(query) ||
        row.logPath.toLowerCase().includes(query)
      );
    });
  }, [rows, search]);

  const sorted = useMemo(() => {
    const next = [...filtered];
    next.sort((a, b) => {
      let cmp = 0;
      switch (sort.column) {
        case "name":
          cmp = displayName(a).localeCompare(displayName(b), undefined, {
            sensitivity: "base",
            numeric: true,
          });
          break;
        case "size":
          cmp = (a.sizeBytes ?? -1) - (b.sizeBytes ?? -1);
          break;
        case "path":
          cmp = (a.logPath || "").localeCompare(b.logPath || "", undefined, { sensitivity: "base" });
          break;
      }
      return sort.direction === "asc" ? cmp : -cmp;
    });
    return next;
  }, [filtered, sort.column, sort.direction]);

  const handleClear = useCallback(
    (row: DockerContainerLogInfo) => {
      void (async () => {
        const name = displayName(row);
        const confirmed = await appConfirm(
          t("docker.dockPanel.logsClearConfirm"),
          t("docker.dockPanel.logsClear"),
          { kind: "warning", confirmLabel: t("docker.dockPanel.logsClear") },
        );
        if (!confirmed) return;
        setPendingIds((current) => ({ ...current, [row.containerId]: true }));
        try {
          const res = await commands.dockerClearContainerLogs(connection.connectionId, row.containerId);
          if (res.status !== "ok") throw new Error(res.error.message);
          showToast(t("docker.containerLogsPanel.cleared", { name }));
          await refresh();
        } catch (err) {
          showToast(`${t("docker.containerLogsPanel.clearFailed")}: ${String(err)}`);
        } finally {
          setPendingIds((current) => {
            if (!current[row.containerId]) return current;
            const next = { ...current };
            delete next[row.containerId];
            return next;
          });
        }
      })();
    },
    [connection.connectionId, refresh, t],
  );

  const columns = useMemo((): DbTablesPanelGridColumn<DockerContainerLogInfo>[] => {
    return [
      {
        id: "name",
        sortId: "name",
        header: t("docker.containerLogsPanel.column.name"),
        sortable: true,
        nameCell: true,
        render: (row) => displayName(row),
        getTitle: (row) => displayName(row),
        getCopyValue: (row) => displayName(row),
      },
      {
        id: "size",
        sortId: "size",
        header: t("docker.containerLogsPanel.column.size"),
        sortable: true,
        render: (row) => formatBytes(row.sizeBytes),
        getTitle: (row) => formatBytes(row.sizeBytes),
        getCopyValue: (row) => formatBytes(row.sizeBytes),
      },
      {
        id: "path",
        sortId: "path",
        header: t("docker.containerLogsPanel.column.path"),
        sortable: true,
        render: (row) => row.logPath || "—",
        getTitle: (row) => row.logPath || undefined,
        getCopyValue: (row) => row.logPath || undefined,
      },
      {
        id: "actions",
        header: t("docker.containerLogsPanel.column.actions"),
        variant: "actionsSticky",
        copyable: false,
        render: (row) => {
          const busy = Boolean(pendingIds[row.containerId]);
          return (
            <div className="docker-container-logs-panel__actions" onClick={(e) => e.stopPropagation()}>
              <Button
                type="button"
                variant="icon"
                size="icon-xs"
                title={t("docker.dockPanel.logsClear")}
                aria-label={t("docker.dockPanel.logsClear")}
                disabled={busy || !row.logPath}
                onClick={() => handleClear(row)}
              >
                <TrashIcon />
              </Button>
            </div>
          );
        },
      },
    ];
  }, [handleClear, pendingIds, t]);

  if (!isActive) {
    return <div className="docker-container-logs-panel docker-container-logs-panel--inactive" aria-hidden />;
  }

  const renderTable = () => {
    if (loading && rows.length === 0) {
      return <div className="db-tables-panel-empty">{t("common.loading")}</div>;
    }
    if (error && rows.length === 0) {
      return <div className="db-tables-panel-error">{error}</div>;
    }
    if (rows.length === 0) {
      return <div className="db-tables-panel-empty">{t("docker.containerLogsPanel.empty")}</div>;
    }
    if (sorted.length === 0) {
      return <div className="db-tables-panel-empty">{t("docker.containerLogsPanel.noResults")}</div>;
    }
    return (
      <DbTablesPanelGrid
        variant="variables"
        columns={columns}
        rows={sorted}
        rowKey={(row) => row.containerId}
        sortColumnId={sort.column}
        sortDirection={sort.direction}
        onSortColumn={toggleSort}
      />
    );
  };

  return (
    <ScopedSearch
      className="db-tables-panel db-tables-panel--dock docker-container-logs-panel"
      value={search}
      onChange={setSearch}
      placeholder={t("docker.containerLogsPanel.search")}
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
            : t("docker.containerLogsPanel.count", { count: sorted.length })}
        </span>
      </div>
    </ScopedSearch>
  );
}
