import { useCallback, useMemo, useState, type MouseEvent } from "react";
import { ModuleEmptyState } from "../../components/ui/feedback/ModuleEmptyState";
import { useI18n } from "../../i18n";
import type { DockerConnectionInfo, DockerContainerSummary } from "../../ipc/bindings";
import { appConfirm } from "../../lib/appConfirm";
import { DockerContainerOverviewCard } from "./DockerContainerOverviewCard";
import { DockerContainerSubWindow } from "./subwindows/DockerContainerSubWindow";
import { useDockerContainerGrid } from "./hooks/useDockerContainerGrid";
import { runDockerContainerAction } from "./dockerContainerActions";
import type { DockerContainerLifecycleAction } from "./dockerContainerLifecycle";
import { refreshDockerConnectionSidebarCache } from "./hooks/useDockerConnectionResources";
import type { DockerContainerGridItem } from "./hooks/useDockerContainerGrid";

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

function normalizeContainerKey(containerId: string): string {
  return containerId.trim().toLowerCase();
}

function sortContainerGridItems(items: DockerContainerGridItem[]): DockerContainerGridItem[] {
  return [...items].sort((a, b) => {
    if (a.container.running !== b.container.running) {
      return a.container.running ? -1 : 1;
    }
    return a.container.name.localeCompare(b.container.name);
  });
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

  const containerIdSet = useMemo(() => {
    if (!containerIds?.length) return null;
    return new Set(containerIds.map((id) => id.trim().toLowerCase()));
  }, [containerIds]);

  const sortedItems = useMemo(() => {
    const filtered = containerIdSet
      ? items.filter((item) => {
          const id = item.container.id.trim().toLowerCase();
          const shortId = item.container.shortId.trim().toLowerCase();
          return containerIdSet.has(id) || containerIdSet.has(shortId);
        })
      : items;
    return sortContainerGridItems(filtered);
  }, [containerIdSet, items]);

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

  const renderContainerCard = (item: DockerContainerGridItem) => (
    <DockerContainerOverviewCard
      key={item.container.id}
      container={item.container}
      stats={item.stats}
      t={t}
      navigable
      actionPending={Boolean(pendingActions[normalizeContainerKey(item.container.id)])}
      onOpenDetail={openDetail}
      onOpenAction={openAction}
      onLifecycleAction={handleLifecycleAction}
    />
  );

  if (!isActive) {
    return <div className="docker-dock-panel docker-dock-panel--inactive" aria-hidden />;
  }

  return (
    <>
      <div
        className={[
          "docker-dock-panel",
          embedded ? "docker-dock-panel--embedded" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {!embedded ? (
          <div className="docker-dock-panel__header">
            <div>
              <h2 className="docker-dock-panel__title">{panelTitle ?? connection.name}</h2>
              <p className="docker-dock-panel__subtitle">{panelSubtitle ?? connection.hostLabel}</p>
            </div>
            <span className="badge badge-muted">
              {t("docker.dockPanel.containerCount", { count: sortedItems.length })}
            </span>
          </div>
        ) : null}

        {error || actionError ? (
          <div className="docker-dock-panel__error">{error ?? actionError}</div>
        ) : null}

        {loading && sortedItems.length === 0 ? (
          <div className="docker-dock-panel__loading">{t("docker.dockPanel.loading")}</div>
        ) : sortedItems.length === 0 ? (
          <ModuleEmptyState preset="container" title={t("docker.dockPanel.empty")} />
        ) : (
          <div className="docker-container-grid docker-dock-panel__container-grid">
            {sortedItems.map((item) => renderContainerCard(item))}
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
        connectionSource={connection.source}
        onClose={() => setOpenSubWindow(null)}
      />
    </>
  );
}
