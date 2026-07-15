import { useCallback, useMemo, useState, type MouseEvent } from "react";
import { ModuleEmptyState } from "../../components/ui/feedback/ModuleEmptyState";
import { Button } from "../../components/ui/Button";
import { IconRefresh } from "../../components/ui/Icons";
import { ScopedSearch } from "../../components/ui/search/ScopedSearch";
import { useI18n } from "../../i18n";
import type { DockerConnectionInfo, DockerContainerSummary } from "../../ipc/bindings";
import { appConfirm } from "../../lib/appConfirm";
import {
  DockerContainerListTable,
  type DockerContainerTableSortColumn,
} from "./DockerContainerListTable";
import { useDockerContainerGrid } from "./hooks/useDockerContainerGrid";
import { runDockerContainerAction } from "./dockerContainerActions";
import type { DockerContainerLifecycleAction } from "./dockerContainerLifecycle";
import { formatDockerNetworks } from "./dockerContainerCardFormat";
import { dockerContainerMatchesSearch } from "./dockerTreeSearch";
import { refreshDockerConnectionSidebarCache } from "./hooks/useDockerConnectionResources";
import type { DockerContainerGridItem } from "./hooks/useDockerContainerGrid";
import { DockerContainerSubWindow } from "./subwindows/DockerContainerSubWindow";

export type DockerContainerSubWindowKind = "detail" | "params" | "logs" | "directory";

export interface DockerDockPanelProps {
  connection: DockerConnectionInfo;
  /** 当前连接 dock 面板处于激活态 */
  isActive: boolean;
  /** 嵌入连接信息面板时为 true，隐藏独立顶栏 */
  embedded?: boolean;
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

type SortState = {
  column: DockerContainerTableSortColumn;
  direction: "asc" | "desc";
};

function normalizeContainerKey(containerId: string): string {
  return containerId.trim().toLowerCase();
}

function compareContainerGridItems(
  a: DockerContainerGridItem,
  b: DockerContainerGridItem,
  column: DockerContainerTableSortColumn,
  direction: "asc" | "desc",
): number {
  let cmp = 0;
  switch (column) {
    case "name":
      cmp = (a.container.name || a.container.id).localeCompare(
        b.container.name || b.container.id,
        undefined,
        { sensitivity: "base", numeric: true },
      );
      break;
    case "status":
      cmp = Number(b.container.running) - Number(a.container.running);
      if (cmp === 0) {
        cmp = (a.container.state || "").localeCompare(b.container.state || "", undefined, {
          sensitivity: "base",
        });
      }
      break;
    case "image":
      cmp = (a.container.image || "").localeCompare(b.container.image || "", undefined, {
        sensitivity: "base",
        numeric: true,
      });
      break;
    case "cpu":
      cmp = (a.stats?.cpuPercent ?? -1) - (b.stats?.cpuPercent ?? -1);
      break;
    case "memory":
      cmp = (a.stats?.memoryPercent ?? -1) - (b.stats?.memoryPercent ?? -1);
      break;
    case "networks":
      cmp = (formatDockerNetworks(a.container) || "").localeCompare(
        formatDockerNetworks(b.container) || "",
        undefined,
        { sensitivity: "base" },
      );
      break;
  }
  return direction === "asc" ? cmp : -cmp;
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

export function DockerDockPanel({
  connection,
  isActive,
  embedded = false,
  panelTitle,
  panelSubtitle,
  containerIds,
}: DockerDockPanelProps) {
  const { t } = useI18n();
  const { items, loading, error, refreshNow } = useDockerContainerGrid(connection.connectionId, isActive);
  const [openSubWindow, setOpenSubWindow] = useState<OpenContainerSubWindow | null>(null);
  const [pendingActions, setPendingActions] = useState<Record<string, true>>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortState>({ column: "name", direction: "asc" });

  const containerIdSet = useMemo(() => {
    if (!containerIds?.length) return null;
    return new Set(containerIds.map((id) => id.trim().toLowerCase()));
  }, [containerIds]);

  const filteredItems = useMemo(() => {
    const scoped = containerIdSet
      ? items.filter((item) => {
          const id = item.container.id.trim().toLowerCase();
          const shortId = item.container.shortId.trim().toLowerCase();
          return containerIdSet.has(id) || containerIdSet.has(shortId);
        })
      : items;
    const query = search.trim();
    if (!query) return scoped;
    return scoped.filter(
      (item) =>
        dockerContainerMatchesSearch(query, item.container) ||
        (formatDockerNetworks(item.container) || "").toLowerCase().includes(query.toLowerCase()),
    );
  }, [containerIdSet, items, search]);

  const displayItems = useMemo(() => {
    const sorted = [...filteredItems];
    sorted.sort((a, b) => compareContainerGridItems(a, b, sort.column, sort.direction));
    return sorted;
  }, [filteredItems, sort.column, sort.direction]);

  const toggleSort = useCallback((columnId: string) => {
    const column = columnId as DockerContainerTableSortColumn;
    setSort((prev) =>
      prev.column === column
        ? { column, direction: prev.direction === "asc" ? "desc" : "asc" }
        : { column, direction: column === "cpu" || column === "memory" ? "desc" : "asc" },
    );
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

  const handleRefresh = useCallback(() => {
    refreshNow();
    refreshDockerConnectionSidebarCache(connection.connectionId);
  }, [connection.connectionId, refreshNow]);

  // 非激活：卸载表格 / 子弹窗，保留轻量占位（轮询已由 isActive=false 停止）
  if (!isActive) {
    return (
      <div
        className={[
          "docker-dock-panel",
          embedded ? "docker-dock-panel--embedded" : "",
          "docker-dock-panel--inactive",
        ]
          .filter(Boolean)
          .join(" ")}
        aria-hidden
      />
    );
  }

  return (
    <>
      <ScopedSearch
        className={["docker-dock-panel", embedded ? "docker-dock-panel--embedded" : ""]
          .filter(Boolean)
          .join(" ")}
        value={search}
        onChange={setSearch}
        placeholder={t("docker.dockPanel.search")}
        enabled
      >
        {!embedded ? (
          <div className="docker-dock-panel__header">
            <div>
              <h2 className="docker-dock-panel__title">{panelTitle ?? connection.name}</h2>
              <p className="docker-dock-panel__subtitle">{panelSubtitle ?? connection.hostLabel}</p>
            </div>
          </div>
        ) : null}

        {error || actionError ? (
          <div className="docker-dock-panel__error">{error ?? actionError}</div>
        ) : null}

        <div className="docker-dock-panel__content">
          {loading && displayItems.length === 0 ? (
            <div className="docker-dock-panel__loading">{t("docker.dockPanel.loading")}</div>
          ) : items.length === 0 ? (
            <ModuleEmptyState preset="container" title={t("docker.dockPanel.empty")} />
          ) : displayItems.length === 0 ? (
            <ModuleEmptyState preset="container" title={t("docker.dockPanel.noResults")} />
          ) : (
            <DockerContainerListTable
              items={displayItems}
              pendingActions={pendingActions}
              sortColumnId={sort.column}
              sortDirection={sort.direction}
              onSortColumn={toggleSort}
              onOpenAction={openAction}
              onLifecycleAction={handleLifecycleAction}
            />
          )}
        </div>

        <footer className="docker-dock-panel__footer">
          <div className="docker-dock-panel__footer-left">
            <Button
              type="button"
              variant="icon"
              size="icon-xs"
              className="docker-dock-panel__refresh-btn"
              title={t("common.refresh")}
              aria-label={t("common.refresh")}
              disabled={loading}
              onClick={handleRefresh}
            >
              <IconRefresh size={14} className={loading ? "is-spinning" : undefined} />
            </Button>
            <span className="badge badge-muted">
              {t("docker.dockPanel.containerCount", { count: displayItems.length })}
            </span>
          </div>
        </footer>
      </ScopedSearch>

      <DockerContainerSubWindow
        open={openSubWindow != null}
        kind={openSubWindow?.kind ?? "params"}
        title={openSubWindow ? subWindowTitle(openSubWindow.kind, t) : ""}
        containerName={openSubWindow?.containerName ?? ""}
        connectionId={connection.connectionId}
        containerId={openSubWindow?.containerId ?? ""}
        connectionSource={connection.source}
        onClose={() => setOpenSubWindow(null)}
      />
    </>
  );
}
