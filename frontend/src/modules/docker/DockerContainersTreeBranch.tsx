import { useMemo, useRef, useState, type DragEvent, type MouseEvent } from "react";
import { useI18n } from "@/i18n";
import { ContextMenu, type ContextMenuItem } from "@/components/ui/ContextMenu";
import { SidebarTreeEmpty, SidebarTreeNode } from "@/components/ui/sidebar-tree";
import type { DockerConnectionInfo, DockerContainerSummary } from "@/ipc/bindings";
import { appConfirm } from "@/lib/appConfirm";
import { quickInput } from "@/stores/quickInputStore";
import {
  DOCKER_CONTAINER_DRAG_MIME,
  readDockerContainerDragPayload,
  selectDockerServiceGroups,
  useDockerServiceGroupStore,
} from "@/stores/dockerServiceGroupStore";
import { logDockerDrag, snapshotDataTransfer } from "./dockerDragDebug";
import { useDockerPanelDockStore } from "@/stores/dockerPanelDockStore";
import type { DockerConnectionDockOpenMode } from "./dockerConnectionWorkspaceTabs";
import { containerRowLabel, makeDockerServiceGroupTreeKey, makeDockerTreeKey } from "./dockerResourceLabels";
import type { DockerSidebarNavigate } from "./dockerSidebarNav";
import { DockerTreeIcon, dockerTreeNodeClassName } from "./dockerTreeIcons";
import { DockerTreeRefreshButton } from "./DockerTreeRefreshButton";
import { dockerSidebarCategoryRefreshKey } from "./dockerSidebarCache";

type DockerContainersTreeBranchProps = {
  connection: DockerConnectionInfo;
  containers: DockerContainerSummary[];
  categoryKey: string;
  activeNavKey: string | null;
  loading: boolean;
  error: string | null;
  isExpanded: (key: string) => boolean;
  toggle: (key: string) => void;
  ensureExpanded: (key: string) => void;
  onNavigate: DockerSidebarNavigate;
  onRefreshCategory: () => void;
};

function normalizeContainerId(containerId: string): string {
  return containerId.trim().toLowerCase();
}

export function DockerContainersTreeBranch({
  connection,
  containers,
  categoryKey,
  activeNavKey,
  loading,
  error,
  isExpanded,
  toggle,
  ensureExpanded,
  onNavigate,
  onRefreshCategory,
}: DockerContainersTreeBranchProps) {
  const { t } = useI18n();
  const dragContainerIdRef = useRef<string | null>(null);
  const [dropTargetGroupId, setDropTargetGroupId] = useState<string | null>(null);
  const [ctxPos, setCtxPos] = useState<{ x: number; y: number } | null>(null);
  const [ctxGroupId, setCtxGroupId] = useState<string | null>(null);

  const serviceGroups = useDockerServiceGroupStore(selectDockerServiceGroups(connection.connectionId));
  const renameGroup = useDockerServiceGroupStore((state) => state.renameGroup);
  const deleteGroup = useDockerServiceGroupStore((state) => state.deleteGroup);
  const assignContainerToGroup = useDockerServiceGroupStore((state) => state.assignContainerToGroup);
  const removeServiceGroupTabs = useDockerPanelDockStore((state) => state.removeServiceGroupTabs);

  const groupedContainerIdSet = useMemo(() => {
    const set = new Set<string>();
    for (const group of serviceGroups) {
      for (const containerId of group.containerIds) {
        set.add(normalizeContainerId(containerId));
      }
    }
    return set;
  }, [serviceGroups]);

  const ungroupedContainers = useMemo(
    () => containers.filter((container) => !groupedContainerIdSet.has(normalizeContainerId(container.id))),
    [containers, groupedContainerIdSet],
  );

  const containerById = useMemo(() => {
    const map = new Map<string, DockerContainerSummary>();
    for (const container of containers) {
      map.set(normalizeContainerId(container.id), container);
      map.set(normalizeContainerId(container.shortId), container);
    }
    return map;
  }, [containers]);

  const openServiceGroup = (groupId: string, mode?: DockerConnectionDockOpenMode) => {
    ensureExpanded(makeDockerTreeKey(connection.connectionId));
    ensureExpanded(categoryKey);
    ensureExpanded(makeDockerServiceGroupTreeKey(connection.connectionId, groupId));
    onNavigate(
      {
        connectionId: connection.connectionId,
        category: "containers",
        serviceGroupId: groupId,
      },
      mode,
    );
  };

  const handleDragStart = (containerId: string, event: DragEvent<HTMLDivElement>) => {
    dragContainerIdRef.current = containerId;
    event.dataTransfer.effectAllowed = "move";
    const payload = JSON.stringify({ connectionId: connection.connectionId, containerId });
    event.dataTransfer.setData(DOCKER_CONTAINER_DRAG_MIME, payload);
    // WebView / Tauri 需要 text/plain 才能稳定发起拖放
    event.dataTransfer.setData("text/plain", payload);
    logDockerDrag("dragstart", {
      containerId,
      connectionId: connection.connectionId,
      targetTag: (event.target as Element | null)?.tagName ?? null,
      ...snapshotDataTransfer(event.dataTransfer),
    });
  };

  const handleGroupDragOver = (groupId: string, event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setDropTargetGroupId(groupId);
    logDockerDrag("dragover:group", {
      groupId,
      dropEffect: event.dataTransfer.dropEffect,
      types: Array.from(event.dataTransfer.types),
    });
  };

  const handleGroupDrop = (groupId: string, event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDropTargetGroupId(null);

    const transferSnapshot = snapshotDataTransfer(event.dataTransfer);
    const payload = readDockerContainerDragPayload(event.dataTransfer);
    const refContainerId = dragContainerIdRef.current;
    const containerId = payload?.containerId ?? refContainerId;
    dragContainerIdRef.current = null;

    logDockerDrag("drop:group", {
      groupId,
      connectionId: connection.connectionId,
      payload,
      refContainerId,
      resolvedContainerId: containerId,
      ...transferSnapshot,
    });

    if (!containerId) {
      logDockerDrag("drop:reject", { reason: "missing-container-id" });
      return;
    }
    if (payload?.connectionId && payload.connectionId !== connection.connectionId) {
      logDockerDrag("drop:reject", {
        reason: "connection-mismatch",
        expected: connection.connectionId,
        got: payload.connectionId,
      });
      return;
    }

    logDockerDrag("drop:assign", {
      groupId,
      containerId,
      connectionId: connection.connectionId,
    });
    assignContainerToGroup(connection.connectionId, containerId, groupId);
  };

  const handleGroupContextMenu = (groupId: string, event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setCtxGroupId(groupId);
    setCtxPos({ x: event.clientX, y: event.clientY });
  };

  const ctxItems: ContextMenuItem[] = ctxGroupId
    ? [
        {
          id: "rename",
          label: t("docker.sidebar.renameServiceGroup"),
          onClick: () => {
            void (async () => {
              const group = serviceGroups.find((item) => item.id === ctxGroupId);
              if (!group) return;
              const name = await quickInput({
                title: t("docker.sidebar.renameServiceGroup"),
                subtitle: t("docker.sidebar.serviceGroupPrompt"),
                defaultValue: group.name,
              });
              if (!name?.trim()) return;
              renameGroup(connection.connectionId, ctxGroupId, name);
            })();
          },
        },
        {
          id: "delete",
          label: t("docker.sidebar.deleteServiceGroup"),
          danger: true,
          onClick: () => {
            void (async () => {
              if (!(await appConfirm(t("docker.sidebar.deleteServiceGroupConfirm")))) return;
              deleteGroup(connection.connectionId, ctxGroupId);
              removeServiceGroupTabs(connection.connectionId, ctxGroupId);
            })();
          },
        },
      ]
    : [];

  const renderContainerNode = (container: DockerContainerSummary, depth: number) => {
    const itemKey = makeDockerTreeKey(connection.connectionId, "containers", container.id);
    const containersRefreshKey = dockerSidebarCategoryRefreshKey(connection.connectionId, "containers");
    const openItem = (mode?: DockerConnectionDockOpenMode) => {
      ensureExpanded(makeDockerTreeKey(connection.connectionId));
      ensureExpanded(categoryKey);
      onNavigate(
        {
          connectionId: connection.connectionId,
          category: "containers",
          itemId: container.id,
        },
        mode,
      );
    };

    return (
      <SidebarTreeNode
        key={container.id}
        depth={depth}
        module="docker"
        nodeType="container"
        treeKey={itemKey}
        label={containerRowLabel(container)}
        icon={<DockerTreeIcon kind="container" />}
        className={dockerTreeNodeClassName("container")}
        hasChildren={false}
        expanded={false}
        active={activeNavKey === itemKey}
        draggable
        clickDelayMs={0}
        shouldIgnoreClick={(target) =>
          Boolean((target as HTMLElement | null)?.closest(".tree-action-btn"))
        }
        onDragStart={(event) => handleDragStart(container.id, event)}
        onDragEnd={(event) => {
          logDockerDrag("dragend", {
            dropEffect: event.dataTransfer.dropEffect,
            refContainerId: dragContainerIdRef.current,
          });
          dragContainerIdRef.current = null;
          setDropTargetGroupId(null);
        }}
        onToggle={() => {}}
        onSelect={() => openItem("preview")}
        onActivate={() => openItem("permanent")}
        trailing={
          <div className="tree-node-actions">
            <DockerTreeRefreshButton refreshKey={containersRefreshKey} onRefresh={onRefreshCategory} />
          </div>
        }
      />
    );
  };

  if (loading && containers.length === 0) {
    return <SidebarTreeEmpty>{t("docker.sidebar.treeLoading")}</SidebarTreeEmpty>;
  }
  if (error && containers.length === 0) {
    return <SidebarTreeEmpty>{error}</SidebarTreeEmpty>;
  }
  if (containers.length === 0 && serviceGroups.length === 0) {
    return <SidebarTreeEmpty>{t("docker.sidebar.treeEmpty")}</SidebarTreeEmpty>;
  }

  return (
    <>
      {serviceGroups.map((group) => {
        const groupKey = makeDockerServiceGroupTreeKey(connection.connectionId, group.id);
        const groupExpanded = isExpanded(groupKey);
        const containersRefreshKey = dockerSidebarCategoryRefreshKey(connection.connectionId, "containers");
        const groupContainers = group.containerIds
          .map((id) => containerById.get(normalizeContainerId(id)))
          .filter((item): item is DockerContainerSummary => item != null);

        return (
          <div key={group.id} className="server-tree-category">
            <SidebarTreeNode
              depth={2}
              module="docker"
              nodeType="service-group"
              treeKey={groupKey}
              label={group.name}
              icon={<DockerTreeIcon kind="service-group" />}
              className={[
                dockerTreeNodeClassName("service-group"),
                dropTargetGroupId === group.id ? "docker-tree-node--drop-target" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              hasChildren
              expanded={groupExpanded}
              active={activeNavKey === groupKey}
              onToggle={() => toggle(groupKey)}
              onActivate={() => openServiceGroup(group.id, "permanent")}
              onDragOver={(event) => handleGroupDragOver(group.id, event)}
              onDrop={(event) => handleGroupDrop(group.id, event)}
              onDragLeave={() => setDropTargetGroupId((current) => (current === group.id ? null : current))}
              onContextMenu={(event) => handleGroupContextMenu(group.id, event)}
              shouldIgnoreClick={(target) =>
                Boolean((target as HTMLElement | null)?.closest(".tree-action-btn"))
              }
              trailing={
                <>
                  <span className="server-tree-badge">{groupContainers.length}</span>
                  <div className="tree-node-actions">
                    <DockerTreeRefreshButton refreshKey={containersRefreshKey} onRefresh={onRefreshCategory} />
                  </div>
                </>
              }
            />
            {groupExpanded && groupContainers.length > 0 ? (
              <div className="server-tree-children">
                {groupContainers.map((container) => renderContainerNode(container, 3))}
              </div>
            ) : null}
          </div>
        );
      })}

      {ungroupedContainers.map((container) => renderContainerNode(container, 2))}

      {ctxPos ? (
        <ContextMenu items={ctxItems} position={ctxPos} onClose={() => setCtxPos(null)} />
      ) : null}
    </>
  );
}
