import { useCallback, useMemo, useState, type MouseEvent } from "react";
import { ModuleEmptyState } from "../../components/ui/feedback/ModuleEmptyState";
import { useI18n } from "../../i18n";
import type { DockerConnectionInfo, DockerContainerSummary } from "../../ipc/bindings";
import { appConfirm } from "../../lib/appConfirm";
import { selectDockerServiceGroups, useDockerServiceGroupStore } from "../../stores/dockerServiceGroupStore";
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

type ContainerDisplaySection = {
  key: string;
  title: string;
  items: DockerContainerGridItem[];
};

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
  panelTitle,
  panelSubtitle,
  containerIds,
}: DockerDockPanelProps) {
  const { t } = useI18n();
  const { items, loading, error, refreshNow } = useDockerContainerGrid(connection.connectionId, isActive);
  const serviceGroups = useDockerServiceGroupStore(selectDockerServiceGroups(connection.connectionId));
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

  const sortedItems = useMemo(() => sortContainerGridItems(filteredItems), [filteredItems]);

  const containerItemByKey = useMemo(() => {
    const map = new Map<string, DockerContainerGridItem>();
    for (const item of sortedItems) {
      map.set(normalizeContainerKey(item.container.id), item);
      map.set(normalizeContainerKey(item.container.shortId), item);
    }
    return map;
  }, [sortedItems]);

  const groupedContainerIdSet = useMemo(() => {
    const set = new Set<string>();
    for (const group of serviceGroups) {
      for (const containerId of group.containerIds) {
        set.add(normalizeContainerKey(containerId));
      }
    }
    return set;
  }, [serviceGroups]);

  const displaySections = useMemo((): ContainerDisplaySection[] | null => {
    if (containerIdSet) return null;

    const sections: ContainerDisplaySection[] = [];

    for (const group of serviceGroups) {
      const groupItems = sortContainerGridItems(
        group.containerIds
          .map((id) => containerItemByKey.get(normalizeContainerKey(id)))
          .filter((item): item is DockerContainerGridItem => item != null),
      );
      if (groupItems.length === 0) continue;
      sections.push({
        key: group.id,
        title: group.name,
        items: groupItems,
      });
    }

    const ungroupedItems = sortContainerGridItems(
      sortedItems.filter((item) => !groupedContainerIdSet.has(normalizeContainerKey(item.container.id))),
    );
    if (ungroupedItems.length > 0) {
      sections.push({
        key: "__ungrouped__",
        title: t("docker.dockPanel.ungrouped"),
        items: ungroupedItems,
      });
    }

    return sections;
  }, [containerIdSet, containerItemByKey, groupedContainerIdSet, serviceGroups, sortedItems, t]);

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
        ) : displaySections ? (
          <div className="docker-dock-panel__body">
            {displaySections.map((section) => (
              <section key={section.key} className="docker-dock-panel__section">
                <h3 className="docker-dock-panel__section-title">
                  {section.title}
                  <span className="docker-dock-panel__section-count">{section.items.length}</span>
                </h3>
                <div className="docker-container-grid docker-dock-panel__container-grid docker-dock-panel__section-grid">
                  {section.items.map((item) => renderContainerCard(item))}
                </div>
              </section>
            ))}
          </div>
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
