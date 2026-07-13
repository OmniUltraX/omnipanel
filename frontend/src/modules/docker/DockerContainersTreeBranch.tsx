import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useI18n } from "@/i18n";
import { ContextMenu, type ContextMenuItem } from "@/components/ui/ContextMenu";
import { SidebarTreeEmpty, SidebarTreeNode, useSidebarTreeSelection } from "@/components/ui/sidebar-tree";
import type { DockerConnectionInfo, DockerContainerSummary } from "@/ipc/bindings";
import { appConfirm } from "@/lib/appConfirm";
import { quickInput } from "@/stores/quickInputStore";
import {
  selectDockerServiceGroups,
  useDockerServiceGroupStore,
} from "@/stores/dockerServiceGroupStore";
import { logDockerDrag } from "./dockerDragDebug";
import {
  DOCKER_CONTAINER_POINTER_DRAG_THRESHOLD_PX,
  isDockerContainerPointerDragExcluded,
  resolveDockerServiceGroupDropFromPointer,
} from "./dockerContainerPointerDnD";
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

function parseContainerIdFromTreeKey(connectionId: string, treeKey: string): string | null {
  const prefix = `docker:${connectionId}:containers:`;
  if (!treeKey.startsWith(prefix)) return null;
  const suffix = treeKey.slice(prefix.length);
  if (!suffix || suffix.startsWith("group:")) return null;
  return suffix;
}

function resolveDragContainerIds(
  connectionId: string,
  containerId: string,
  itemKey: string,
  selection: ReturnType<typeof useSidebarTreeSelection>,
  containerById: Map<string, DockerContainerSummary>,
): string[] {
  if (!selection || !selection.isSelected(itemKey) || selection.selectedIds.size <= 1) {
    return [containerId];
  }

  const ids: string[] = [];
  for (const treeKey of selection.selectedIds) {
    const id = parseContainerIdFromTreeKey(connectionId, treeKey);
    if (!id) continue;
    const container = containerById.get(normalizeContainerId(id));
    if (container) {
      ids.push(container.id);
    }
  }

  return ids.length > 0 ? ids : [containerId];
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
  const selection = useSidebarTreeSelection();
  const [dropTargetGroupId, setDropTargetGroupId] = useState<string | null>(null);
  const [draggingContainerIds, setDraggingContainerIds] = useState<ReadonlySet<string>>(() => new Set());
  const [ctxPos, setCtxPos] = useState<{ x: number; y: number } | null>(null);
  const [ctxGroupId, setCtxGroupId] = useState<string | null>(null);
  const skipClickAfterDropRef = useRef(false);
  const pointerDragRef = useRef<{
    containerIds: string[];
    pointerId: number;
    startX: number;
    startY: number;
    active: boolean;
  } | null>(null);

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

  const cleanupPointerDrag = useCallback(() => {
    pointerDragRef.current = null;
    setDraggingContainerIds(new Set());
    setDropTargetGroupId(null);
    document.body.classList.remove("docker-sidebar-tree--pointer-dragging");
    document.body.style.cursor = "";
  }, []);

  const applyPointerDrop = useCallback(
    (containerIds: string[], groupId: string) => {
      logDockerDrag("pointer-drop:assign", {
        groupId,
        containerIds,
        count: containerIds.length,
        connectionId: connection.connectionId,
      });
      for (const containerId of containerIds) {
        assignContainerToGroup(connection.connectionId, containerId, groupId);
      }
      ensureExpanded(makeDockerServiceGroupTreeKey(connection.connectionId, groupId));
    },
    [assignContainerToGroup, connection.connectionId, ensureExpanded],
  );

  const handleContainerPointerDown = useCallback(
    (containerId: string, itemKey: string, event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      if (isDockerContainerPointerDragExcluded(event.target)) return;
      const containerIds = resolveDragContainerIds(
        connection.connectionId,
        containerId,
        itemKey,
        selection,
        containerById,
      );
      pointerDragRef.current = {
        containerIds,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        active: false,
      };
    },
    [connection.connectionId, containerById, selection],
  );

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const session = pointerDragRef.current;
      if (!session || event.pointerId !== session.pointerId) return;

      const dx = event.clientX - session.startX;
      const dy = event.clientY - session.startY;
      if (!session.active) {
        if (Math.hypot(dx, dy) < DOCKER_CONTAINER_POINTER_DRAG_THRESHOLD_PX) return;
        session.active = true;
        setDraggingContainerIds(new Set(session.containerIds));
        document.body.classList.add("docker-sidebar-tree--pointer-dragging");
        document.body.style.cursor = "grabbing";
        logDockerDrag("pointer-drag:start", {
          containerIds: session.containerIds,
          count: session.containerIds.length,
          connectionId: connection.connectionId,
        });
      }

      event.preventDefault();
      const groupId = resolveDockerServiceGroupDropFromPointer(
        event.clientX,
        event.clientY,
        connection.connectionId,
      );
      setDropTargetGroupId(groupId);
      if (groupId) {
        ensureExpanded(makeDockerServiceGroupTreeKey(connection.connectionId, groupId));
        logDockerDrag("pointer-drag:hover", { groupId });
      }
    };

    const finishPointerDrag = (event: PointerEvent) => {
      const session = pointerDragRef.current;
      if (!session || event.pointerId !== session.pointerId) return;

      if (session.active) {
        const groupId = resolveDockerServiceGroupDropFromPointer(
          event.clientX,
          event.clientY,
          connection.connectionId,
        );
        logDockerDrag("pointer-drag:finish", {
          containerIds: session.containerIds,
          count: session.containerIds.length,
          groupId,
          connectionId: connection.connectionId,
        });
        if (groupId) {
          skipClickAfterDropRef.current = true;
          applyPointerDrop(session.containerIds, groupId);
        }
      }

      cleanupPointerDrag();
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", finishPointerDrag);
    window.addEventListener("pointercancel", finishPointerDrag);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", finishPointerDrag);
      window.removeEventListener("pointercancel", finishPointerDrag);
      cleanupPointerDrag();
    };
  }, [applyPointerDrop, cleanupPointerDrag, connection.connectionId, ensureExpanded]);

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

    const isDragging = draggingContainerIds.has(container.id);

    return (
      <SidebarTreeNode
        key={container.id}
        depth={depth}
        module="docker"
        nodeType="container"
        treeKey={itemKey}
        label={containerRowLabel(container)}
        icon={<DockerTreeIcon kind="container" />}
        className={[
          dockerTreeNodeClassName("container"),
          "docker-tree-node--pointer-draggable",
          isDragging ? "docker-tree-node--dragging" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        hasChildren={false}
        expanded={false}
        active={activeNavKey === itemKey}
        dataAttrs={{ "data-docker-container-id": container.id }}
        shouldIgnoreClick={(target) => {
          if (skipClickAfterDropRef.current) {
            skipClickAfterDropRef.current = false;
            return true;
          }
          return Boolean((target as HTMLElement | null)?.closest(".tree-action-btn"));
        }}
        onPointerDown={(event) => handleContainerPointerDown(container.id, itemKey, event)}
        onToggle={() => {}}
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

        const isDropTarget = dropTargetGroupId === group.id;

        return (
          <div
            key={group.id}
            className={[
              "server-tree-category",
              "docker-service-group-category",
              isDropTarget ? "docker-service-group-category--drop-target" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            data-docker-connection-id={connection.connectionId}
            data-docker-service-group-id={group.id}
          >
            <SidebarTreeNode
              depth={2}
              module="docker"
              nodeType="service-group"
              treeKey={groupKey}
              label={group.name}
              icon={<DockerTreeIcon kind="service-group" />}
              className={[
                dockerTreeNodeClassName("service-group"),
                isDropTarget ? "docker-tree-node--drop-target" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              hasChildren
              expanded={groupExpanded}
              active={activeNavKey === groupKey}
              onToggle={() => toggle(groupKey)}
              onActivate={() => openServiceGroup(group.id, "permanent")}
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
            {groupExpanded ? (
              <div
                className={[
                  "server-tree-children",
                  "docker-service-group-drop-zone",
                  groupContainers.length === 0 ? "docker-service-group-drop-zone--empty" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                {groupContainers.length === 0 ? (
                  <div className="docker-service-group-drop-zone__hint">
                    {t("docker.sidebar.dropContainerHint")}
                  </div>
                ) : null}
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
