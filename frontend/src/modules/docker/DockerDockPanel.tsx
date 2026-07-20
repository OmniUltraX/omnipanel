import { useCallback, useEffect, useMemo, useState, type MouseEvent } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { ModuleEmptyState } from "../../components/ui/feedback/ModuleEmptyState";
import { Button } from "../../components/ui/Button";
import { IconChevronDown, IconPlus, IconRefresh } from "../../components/ui/Icons";
import { IconDropdownButton } from "../../components/ui/menu/IconDropdownButton";
import { ScopedSearch } from "../../components/ui/search/ScopedSearch";
import { useI18n } from "../../i18n";
import type { DockerConnectionInfo, DockerContainerSummary } from "../../ipc/bindings";
import { formatIpcError } from "../../ipc/result";
import { appConfirm } from "../../lib/appConfirm";
import { showToast } from "../../stores/toastStore";
import {
  DockerContainerListTable,
  type DockerComposeGroupAction,
  type DockerContainerTableSortColumn,
} from "./DockerContainerListTable";
import { useDockerContainerGrid } from "./hooks/useDockerContainerGrid";
import { runDockerContainerAction } from "./dockerContainerActions";
import {
  getComposeProjectMeta,
  invalidateComposeProjectMeta,
  runComposeAction,
} from "./dockerComposeApi";
import { splitComposeFilePath } from "./dockerComposeFilePath";
import { resolveComposeProjectName } from "./dockerComposeGroups";
import type { DockerContainerLifecycleAction } from "./dockerContainerLifecycle";
import { formatDockerNetworks } from "./dockerContainerCardFormat";
import { dockerContainerMatchesSearch } from "./dockerTreeSearch";
import { refreshDockerConnectionSidebarCache } from "./hooks/useDockerConnectionResources";
import type { DockerContainerGridItem } from "./hooks/useDockerContainerGrid";
import { DockerContainerSubWindow } from "./subwindows/DockerContainerSubWindow";
import { DockerCreateComposeSubWindow } from "./subwindows/DockerCreateComposeSubWindow";
import { DockerCreateContainerSubWindow } from "./subwindows/DockerCreateContainerSubWindow";

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
    case "status": {
      // running 优先；同态再比 state / statusText，避免全停/全跑时看起来「无变化」之外仍可区分过渡态
      const rank = (item: DockerContainerGridItem) => {
        if (item.container.running) return 2;
        const state = `${item.container.state} ${item.container.statusText}`.toLowerCase();
        if (
          state.includes("restarting") ||
          state.includes("starting") ||
          state.includes("stopping") ||
          state.includes("paused")
        ) {
          return 1;
        }
        return 0;
      };
      cmp = rank(b) - rank(a);
      if (cmp === 0) {
        cmp = (a.container.statusText || a.container.state || "").localeCompare(
          b.container.statusText || b.container.state || "",
          undefined,
          { sensitivity: "base" },
        );
      }
      break;
    }
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
  const { items, loading, error, refreshNow } = useDockerContainerGrid(
    connection.connectionId,
    // 离线时停容器列表 / stats 轮询，避免本机 Engine 未启动时反复刷 Connect 错误
    isActive && connection.status !== "offline",
  );
  const [openSubWindow, setOpenSubWindow] = useState<OpenContainerSubWindow | null>(null);
  const [createContainerOpen, setCreateContainerOpen] = useState(false);
  const [createComposeOpen, setCreateComposeOpen] = useState(false);
  const [composeRunBusy, setComposeRunBusy] = useState(false);
  const [pendingActions, setPendingActions] = useState<Record<string, true>>({});
  const [pendingComposeProjects, setPendingComposeProjects] = useState<
    Record<string, DockerComposeGroupAction>
  >({});
  /** 折叠中的 Compose 项目；默认空 = 全部展开 */
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set());
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

  const composeProjectNames = useMemo(() => {
    const names = new Set<string>();
    for (const item of displayItems) {
      const project = resolveComposeProjectName(item.container);
      if (project) names.add(project);
    }
    return [...names].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }),
    );
  }, [displayItems]);

  // 项目消失时清理折叠集合，避免残留导致按钮状态错误
  useEffect(() => {
    const valid = new Set(composeProjectNames);
    setCollapsedProjects((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const name of prev) {
        if (valid.has(name)) next.add(name);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [composeProjectNames]);

  const hasAnyCollapsed = useMemo(
    () => composeProjectNames.some((name) => collapsedProjects.has(name)),
    [collapsedProjects, composeProjectNames],
  );

  const handleToggleProject = useCallback((project: string) => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(project)) next.delete(project);
      else next.add(project);
      return next;
    });
  }, []);

  const handleToggleExpandCollapseAll = useCallback(() => {
    if (composeProjectNames.length === 0) return;
    setCollapsedProjects((prev) => {
      const anyCollapsed = composeProjectNames.some((name) => prev.has(name));
      if (anyCollapsed) return new Set();
      return new Set(composeProjectNames);
    });
  }, [composeProjectNames]);

  const handleCreatedResources = useCallback(() => {
    refreshNow();
    refreshDockerConnectionSidebarCache(connection.connectionId);
  }, [connection.connectionId, refreshNow]);

  const handleRunComposeFile = useCallback(() => {
    if (composeRunBusy) return;
    void (async () => {
      setActionError(null);
      try {
        const selected = await openFileDialog({
          title: t("docker.dockPanel.runCompose.pickTitle"),
          multiple: false,
          directory: false,
          filters: [
            { name: "Compose", extensions: ["yml", "yaml"] },
            { name: "All", extensions: ["*"] },
          ],
        });
        if (!selected || typeof selected !== "string") return;

        setComposeRunBusy(true);
        const { workingDir, configFile, project } = splitComposeFilePath(selected);
        const result = await runComposeAction(connection.connectionId, "up", {
          project,
          workingDir,
          configFile,
          services: [],
          detached: true,
        });
        if (result.exitCode !== 0) {
          const detail = [result.stderrExcerpt, result.stdoutExcerpt].filter(Boolean).join("\n");
          throw new Error(detail || t("docker.composePanel.actionFailed"));
        }
        invalidateComposeProjectMeta(connection.connectionId);
        showToast(t("docker.dockPanel.runCompose.success", { project }));
        handleCreatedResources();
      } catch (e) {
        const message = formatIpcError(e) || String(e);
        setActionError(message);
        showToast(message);
      } finally {
        setComposeRunBusy(false);
      }
    })();
  }, [composeRunBusy, connection.connectionId, handleCreatedResources, t]);

  const createMenuItems = useMemo(
    () => [
      {
        id: "create-container",
        label: t("docker.dockPanel.createMenu.createContainer"),
        onSelect: () => setCreateContainerOpen(true),
      },
      {
        id: "run-compose",
        label: t("docker.dockPanel.createMenu.runCompose"),
        disabled: composeRunBusy,
        onSelect: handleRunComposeFile,
      },
      {
        id: "create-compose",
        label: t("docker.dockPanel.createMenu.createCompose"),
        onSelect: () => setCreateComposeOpen(true),
      },
    ],
    [composeRunBusy, handleRunComposeFile, t],
  );

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

  const handleComposeGroupAction = useCallback(
    (project: string, action: DockerComposeGroupAction, event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      if (pendingComposeProjects[project]) return;
      void (async () => {
        const confirmMessage =
          action === "stop"
            ? t("docker.composePanel.stopConfirm", { project })
            : action === "restart"
              ? t("docker.composePanel.restartConfirm", { project })
              : t("docker.composePanel.startConfirm", { project });
        const confirmTitle =
          action === "stop"
            ? t("docker.composePanel.stop")
            : action === "restart"
              ? t("docker.composePanel.restart")
              : t("docker.composePanel.start");
        const confirmed = await appConfirm(confirmMessage, confirmTitle, {
          kind: "warning",
          confirmLabel: confirmTitle,
        });
        if (!confirmed) return;

        setActionError(null);
        setPendingComposeProjects((current) => ({ ...current, [project]: action }));
        try {
          const meta = await getComposeProjectMeta(connection.connectionId, project);
          const configFile = meta?.configFiles?.split(",")[0]?.trim() || null;
          const result = await runComposeAction(connection.connectionId, action, {
            project,
            workingDir: meta?.workingDir ?? null,
            configFile,
            services: [],
            detached: true,
          });
          if (result.exitCode !== 0) {
            const detail = [result.stderrExcerpt, result.stdoutExcerpt].filter(Boolean).join("\n");
            throw new Error(detail || t("docker.composePanel.actionFailed"));
          }
          showToast(
            action === "stop"
              ? t("docker.composePanel.stopped")
              : action === "restart"
                ? t("docker.composePanel.restarted")
                : t("docker.composePanel.started"),
          );
          refreshNow();
          refreshDockerConnectionSidebarCache(connection.connectionId);
        } catch (e) {
          setActionError(String(e));
        } finally {
          setPendingComposeProjects((current) => {
            if (!(project in current)) return current;
            const next = { ...current };
            delete next[project];
            return next;
          });
        }
      })();
    },
    [connection.connectionId, pendingComposeProjects, refreshNow, t],
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
              pendingComposeProjects={pendingComposeProjects}
              collapsedProjects={collapsedProjects}
              onToggleProject={handleToggleProject}
              sortColumnId={sort.column}
              sortDirection={sort.direction}
              onSortColumn={toggleSort}
              onOpenAction={openAction}
              onLifecycleAction={handleLifecycleAction}
              onComposeGroupAction={handleComposeGroupAction}
            />
          )}
        </div>

        <footer className="docker-dock-panel__footer">
          <div className="docker-dock-panel__footer-left">
            <IconDropdownButton
              title={t("docker.dockPanel.createMenu.title")}
              ariaLabel={t("docker.dockPanel.createMenu.title")}
              icon={<IconPlus size={14} />}
              size="icon-xs"
              placement="top"
              menuMinWidth={200}
              disabled={loading || composeRunBusy}
              items={createMenuItems}
            />
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
            {composeProjectNames.length > 0 ? (
              <Button
                type="button"
                variant="icon"
                size="icon-xs"
                className="docker-dock-panel__expand-collapse-btn"
                title={
                  hasAnyCollapsed
                    ? t("docker.containersPanel.expandAll")
                    : t("docker.containersPanel.collapseAll")
                }
                aria-label={
                  hasAnyCollapsed
                    ? t("docker.containersPanel.expandAll")
                    : t("docker.containersPanel.collapseAll")
                }
                onClick={handleToggleExpandCollapseAll}
              >
                <IconChevronDown
                  size={14}
                  className={
                    hasAnyCollapsed
                      ? "docker-dock-panel__expand-collapse-icon"
                      : "docker-dock-panel__expand-collapse-icon docker-dock-panel__expand-collapse-icon--collapse"
                  }
                />
              </Button>
            ) : null}
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
      <DockerCreateContainerSubWindow
        open={createContainerOpen}
        connectionId={connection.connectionId}
        onClose={() => setCreateContainerOpen(false)}
        onCreated={handleCreatedResources}
      />
      <DockerCreateComposeSubWindow
        open={createComposeOpen}
        connectionId={connection.connectionId}
        onClose={() => setCreateComposeOpen(false)}
        onCreated={handleCreatedResources}
      />
    </>
  );
}
