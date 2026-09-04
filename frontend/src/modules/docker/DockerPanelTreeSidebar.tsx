import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { useI18n } from "@/i18n";
import { ContextMenu, type ContextMenuItem } from "@/components/ui/ContextMenu";
import { Button } from "@/components/ui/Button";
import { StatusDot, type StatusDotStatus } from "@/components/ui/primitives/StatusDot";
import {
  VerticalSplitSidebarSection,
  type VerticalSplitSidebarSectionConfig,
} from "@/components/ui/VerticalSplitSidebar";
import {
  SidebarTreeEmpty,
  SidebarTreeNode,
  SidebarTreeRoot,
  SidebarTreeSelectionProvider,
  resolveSidebarTreeDeleteTargets,
  useSidebarTreeSelection,
} from "@/components/ui/sidebar-tree";
import type { DockerConnectionInfo } from "@/ipc/bindings";
import { isBuiltinLocalDockerConnection } from "./constants";
import {
  makeDockerComposeProjectTreeKey,
  makeDockerTreeKey,
} from "./dockerResourceLabels";
import type { DockerSidebarNavigate } from "./dockerSidebarNav";
import { DockerTreeIcon, dockerConnectionIconKind, dockerTreeNodeClassName } from "./dockerTreeIcons";
import {
  connectionSupportsSidebarResources,
  refreshDockerConnectionSidebarCache,
  useDockerConnectionResources,
} from "./hooks/useDockerConnectionResources";
import { DockerContainersTreeBranch } from "./DockerContainersTreeBranch";
import { dockerSourceLabel } from "./dockerConnectionSource";
import { groupContainersByComposeProject } from "./dockerComposeGroups";
import { usePersistedDockerTreeExpanded } from "./usePersistedDockerTreeExpanded";
import { DockerTreeRefreshButton } from "./DockerTreeRefreshButton";
import {
  dockerSidebarCategoryRefreshKey,
  dockerSidebarConnectionRefreshKey,
} from "./dockerSidebarCache";
import { hasSidebarTreeSearch } from "@/lib/sidebarTreeSearch";
import { quickInput } from "@/lib/quickInput";
import { useDockerSidebarCacheStore } from "@/stores/dockerSidebarCacheStore";
import {
  dockerConnectionNameMatchesSearch,
  dockerConnectionSubtreeMatchesSearch,
  dockerComposeProjectMatchesSearch,
} from "./dockerTreeSearch";
import {
  collectAllDockerSidebarTreeKeys,
  dockerSidebarConnectionNodeKey,
  dockerSidebarFolderNodeKey,
  listDockerSidebarChildren,
  parseDockerSidebarFolderTreeKey,
  useDockerSidebarTreeStore,
  type DockerSidebarFolder,
} from "@/stores/dockerSidebarTreeStore";

function statusDotStatus(status: DockerConnectionInfo["status"]): StatusDotStatus {
  if (status === "online") return "online";
  if (status === "degraded") return "connecting";
  return "offline";
}

type DockerTreeBranchProps = {
  connection: DockerConnectionInfo;
  connectionExpanded: boolean;
  activeNavKey: string | null;
  searchQuery: string;
  isExpanded: (key: string) => boolean;
  toggle: (key: string) => void;
  ensureExpanded: (key: string) => void;
  onNavigate: DockerSidebarNavigate;
};

function DockerTreeBranch({
  connection,
  connectionExpanded,
  activeNavKey,
  searchQuery,
  isExpanded,
  toggle,
  ensureExpanded,
  onNavigate,
}: DockerTreeBranchProps) {
  const { t } = useI18n();
  const supportsResources = connectionSupportsSidebarResources(connection);
  const { containers, error, refreshCategory } = useDockerConnectionResources(
    supportsResources ? connection : null,
  );
  const refreshingKeys = useDockerSidebarCacheStore((state) => state.refreshingKeys);
  const connectionRefreshing = Boolean(
    refreshingKeys[dockerSidebarConnectionRefreshKey(connection.connectionId)],
  );
  const connectionNameMatch = dockerConnectionNameMatchesSearch(searchQuery, connection);

  useEffect(() => {
    if (!hasSidebarTreeSearch(searchQuery)) {
      return;
    }
    ensureExpanded(makeDockerTreeKey(connection.connectionId));
    for (const group of groupContainersByComposeProject(containers)) {
      if (dockerComposeProjectMatchesSearch(searchQuery, group.project, group.containers)) {
        ensureExpanded(makeDockerComposeProjectTreeKey(connection.connectionId, group.project));
      }
    }
  }, [connection.connectionId, containers, ensureExpanded, searchQuery]);

  if (!connectionExpanded) return null;

  if (!supportsResources) {
    return (
      <SidebarTreeEmpty style={{ paddingLeft: 28 }}>
        {t("docker.sidebar.treeUnsupported")}
      </SidebarTreeEmpty>
    );
  }

  return (
    <DockerContainersTreeBranch
      connection={connection}
      containers={containers}
      activeNavKey={activeNavKey}
      searchQuery={searchQuery}
      connectionNameMatch={connectionNameMatch}
      loading={
        (connectionRefreshing ||
          Boolean(
            refreshingKeys[dockerSidebarCategoryRefreshKey(connection.connectionId, "containers")],
          )) &&
        containers.length === 0 &&
        error == null
      }
      isExpanded={isExpanded}
      toggle={toggle}
      ensureExpanded={ensureExpanded}
      onNavigate={onNavigate}
      onRefreshCategory={() => refreshCategory("containers")}
    />
  );
}

function FolderIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

/** Ctrl+A 全选 / Delete 删除（仅侧栏指针激活时响应，避免误触右侧面板）。 */
function DockerTreeHotkeys({
  allKeys,
  armedRef,
  onDeleteSelected,
}: {
  allKeys: readonly string[];
  armedRef: MutableRefObject<boolean>;
  onDeleteSelected: (selected: ReadonlySet<string>) => boolean | Promise<boolean>;
}) {
  const selection = useSidebarTreeSelection();
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (!armedRef.current) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(
          "input, textarea, select, [contenteditable=''], [contenteditable='true']",
        )
      ) {
        return;
      }

      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === "a") {
        if (allKeys.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        selectionRef.current?.setSelectedIds(allKeys);
        return;
      }

      if (event.key === "Delete") {
        const selected = selectionRef.current?.selectedIds;
        if (!selected || selected.size === 0) return;
        event.preventDefault();
        event.stopPropagation();
        void Promise.resolve(onDeleteSelected(selected)).then((deleted) => {
          if (deleted) selectionRef.current?.clearSelection();
        });
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [allKeys, armedRef, onDeleteSelected]);

  return null;
}

export interface DockerPanelTreeSidebarProps {
  connections: DockerConnectionInfo[];
  activeConnectionId: string | null;
  activeNavKey: string | null;
  searchQuery?: string;
  loading?: boolean;
  refreshingAll?: boolean;
  importingFromSsh?: boolean;
  onNavigate: DockerSidebarNavigate;
  onCreate?: () => void;
  onImportFromSsh?: () => void;
  onRefreshAll?: () => void;
  onEditConnection?: (connection: DockerConnectionInfo) => void;
  onDeleteConnection?: (connectionIds: string | string[]) => void;
  section?: VerticalSplitSidebarSectionConfig;
}

type CtxTarget =
  | { kind: "blank" }
  | { kind: "folder"; folder: DockerSidebarFolder }
  | { kind: "connection"; connection: DockerConnectionInfo };

export function DockerPanelTreeSidebar({
  connections,
  activeConnectionId,
  activeNavKey,
  searchQuery = "",
  loading,
  refreshingAll,
  importingFromSsh,
  onNavigate,
  onCreate,
  onImportFromSsh,
  onRefreshAll,
  onEditConnection,
  onDeleteConnection,
  section,
}: DockerPanelTreeSidebarProps) {
  const { t } = useI18n();
  const { isExpanded, toggle, ensureExpanded } = usePersistedDockerTreeExpanded();
  const [ctxPos, setCtxPos] = useState<{ x: number; y: number } | null>(null);
  const [ctxTarget, setCtxTarget] = useState<CtxTarget | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const sidebarHotkeysArmedRef = useRef(false);
  const selectedIdsRef = useRef<ReadonlySet<string>>(new Set());
  const handleSelectedIdsChange = useCallback((ids: ReadonlySet<string>) => {
    selectedIdsRef.current = ids;
  }, []);

  const folders = useDockerSidebarTreeStore((s) => s.folders);
  const connectionFolderId = useDockerSidebarTreeStore((s) => s.connectionFolderId);
  const orderByParent = useDockerSidebarTreeStore((s) => s.orderByParent);
  const createFolder = useDockerSidebarTreeStore((s) => s.createFolder);
  const renameFolder = useDockerSidebarTreeStore((s) => s.renameFolder);
  const deleteFolder = useDockerSidebarTreeStore((s) => s.deleteFolder);
  const moveNode = useDockerSidebarTreeStore((s) => s.moveNode);
  const pruneMissingConnections = useDockerSidebarTreeStore((s) => s.pruneMissingConnections);

  useEffect(() => {
    if (!activeConnectionId) return;
    ensureExpanded(makeDockerTreeKey(activeConnectionId));
  }, [activeConnectionId, ensureExpanded]);

  const connectionById = useMemo(() => {
    const map = new Map<string, DockerConnectionInfo>();
    for (const c of connections) map.set(c.connectionId, c);
    return map;
  }, [connections]);

  const connectionIds = useMemo(() => connections.map((c) => c.connectionId), [connections]);

  useEffect(() => {
    pruneMissingConnections(connectionIds);
  }, [connectionIds, pruneMissingConnections]);

  const cacheConnections = useDockerSidebarCacheStore((state) => state.connections);

  const filteredConnections = useMemo(() => {
    const sorted = [...connections].sort((a, b) => a.name.localeCompare(b.name));
    if (!hasSidebarTreeSearch(searchQuery)) {
      return sorted;
    }
    return sorted.filter((connection) => {
      const entry = useDockerSidebarCacheStore.getState().getEntry(connection.connectionId);
      return dockerConnectionSubtreeMatchesSearch(searchQuery, connection, entry);
    });
  }, [cacheConnections, connections, searchQuery]);

  const searching = hasSidebarTreeSearch(searchQuery);

  const allTreeKeys = useMemo(() => {
    if (searching) {
      return filteredConnections.map((c) => makeDockerTreeKey(c.connectionId));
    }
    return collectAllDockerSidebarTreeKeys(
      { folders, orderByParent, connectionFolderId },
      connectionIds,
      makeDockerTreeKey,
    );
  }, [
    connectionFolderId,
    connectionIds,
    filteredConnections,
    folders,
    orderByParent,
    searching,
  ]);

  useEffect(() => {
    if (!searching) return;
    for (const connection of filteredConnections) {
      ensureExpanded(makeDockerTreeKey(connection.connectionId));
    }
  }, [ensureExpanded, filteredConnections, searching]);

  const openCtx = (event: MouseEvent, target: CtxTarget) => {
    event.preventDefault();
    event.stopPropagation();
    sidebarHotkeysArmedRef.current = true;
    setCtxPos({ x: event.clientX, y: event.clientY });
    setCtxTarget(target);
  };

  const connectionKeyById = useMemo(() => {
    const map = new Map<string, string>();
    for (const connection of connections) {
      map.set(makeDockerTreeKey(connection.connectionId), connection.connectionId);
    }
    return map;
  }, [connections]);

  const isDeletableConnectionKey = useCallback(
    (key: string) => {
      const connectionId = connectionKeyById.get(key);
      return Boolean(connectionId && !isBuiltinLocalDockerConnection(connectionId));
    },
    [connectionKeyById],
  );

  const isDeletableTreeKey = useCallback(
    (key: string) => {
      if (parseDockerSidebarFolderTreeKey(key)) return true;
      return isDeletableConnectionKey(key);
    },
    [isDeletableConnectionKey],
  );

  const resolveDeletableConnectionIds = useCallback(
    (clickedKey?: string | null) => {
      const keys =
        clickedKey != null
          ? resolveSidebarTreeDeleteTargets(clickedKey, selectedIdsRef.current, {
              filter: isDeletableConnectionKey,
            })
          : Array.from(selectedIdsRef.current).filter(isDeletableConnectionKey);
      return keys
        .map((key) => connectionKeyById.get(key))
        .filter((id): id is string => Boolean(id));
    },
    [connectionKeyById, isDeletableConnectionKey],
  );

  const handleHotkeyDelete = useCallback(
    async (selected: ReadonlySet<string>) => {
      const keys = Array.from(selected).filter(isDeletableTreeKey);
      if (keys.length === 0) return false;

      const folderIds = keys
        .map((key) => parseDockerSidebarFolderTreeKey(key))
        .filter((id): id is string => Boolean(id));
      const connectionIdsToDelete = keys
        .filter(isDeletableConnectionKey)
        .map((key) => connectionKeyById.get(key))
        .filter((id): id is string => Boolean(id));

      if (connectionIdsToDelete.length > 0 && onDeleteConnection) {
        onDeleteConnection(
          connectionIdsToDelete.length === 1
            ? connectionIdsToDelete[0]!
            : connectionIdsToDelete,
        );
      }
      for (const folderId of folderIds) {
        deleteFolder(folderId);
      }
      return connectionIdsToDelete.length > 0 || folderIds.length > 0;
    },
    [
      connectionKeyById,
      deleteFolder,
      isDeletableConnectionKey,
      isDeletableTreeKey,
      onDeleteConnection,
    ],
  );

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      sidebarHotkeysArmedRef.current = Boolean(rootRef.current?.contains(event.target as Node));
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, []);

  const handleCreateFolder = (parentId: string | null) => {
    void (async () => {
      const name = await quickInput({
        title: t("docker.sidebar.newFolder"),
        subtitle: t("docker.sidebar.newFolderPrompt"),
        placeholder: t("docker.sidebar.newFolderDefault"),
        defaultValue: t("docker.sidebar.newFolderDefault"),
        validate: (value) => (value.trim() ? null : t("quickInput.required")),
      });
      if (name == null) return;
      const id = createFolder(name, parentId);
      ensureExpanded(`docker-folder:${id}`);
    })();
  };

  const handleRenameFolder = (folder: DockerSidebarFolder) => {
    void (async () => {
      const name = await quickInput({
        title: t("docker.sidebar.renameFolder"),
        subtitle: t("docker.sidebar.renameFolderPrompt"),
        placeholder: folder.name,
        defaultValue: folder.name,
        validate: (value) => (value.trim() ? null : t("quickInput.required")),
      });
      if (name == null) return;
      renameFolder(folder.id, name);
    })();
  };

  const ctxItems: ContextMenuItem[] = (() => {
    if (!ctxTarget) return [];
    if (ctxTarget.kind === "blank") {
      return [
        {
          id: "new-folder",
          label: t("docker.sidebar.newFolder"),
          onClick: () => handleCreateFolder(null),
        },
      ];
    }
    if (ctxTarget.kind === "folder") {
      return [
        {
          id: "new-folder",
          label: t("docker.sidebar.newFolder"),
          onClick: () => handleCreateFolder(ctxTarget.folder.id),
        },
        {
          id: "rename-folder",
          label: t("docker.sidebar.renameFolder"),
          onClick: () => handleRenameFolder(ctxTarget.folder),
        },
        {
          id: "delete-folder",
          label: t("docker.sidebar.deleteFolder"),
          danger: true,
          onClick: () => deleteFolder(ctxTarget.folder.id),
        },
      ];
    }
    const items: ContextMenuItem[] = [
      {
        id: "new-folder",
        label: t("docker.sidebar.newFolder"),
        onClick: () => handleCreateFolder(null),
      },
    ];
    if (!isBuiltinLocalDockerConnection(ctxTarget.connection.connectionId)) {
      items.push(
        {
          id: "edit",
          label: t("docker.sidebar.edit"),
          onClick: () => onEditConnection?.(ctxTarget.connection),
        },
        {
          id: "delete",
          label: t("docker.sidebar.delete"),
          danger: true,
          onClick: () => {
            if (!onDeleteConnection) return;
            const ids = resolveDeletableConnectionIds(
              makeDockerTreeKey(ctxTarget.connection.connectionId),
            );
            if (ids.length === 0) return;
            onDeleteConnection(ids.length === 1 ? ids[0]! : ids);
          },
        },
      );
    }
    return items;
  })();

  const onDragStartNode = (event: DragEvent, nodeKey: string) => {
    event.dataTransfer.setData("text/omnipanel-docker-sidebar", nodeKey);
    event.dataTransfer.effectAllowed = "move";
  };

  const onDragOverNode = (event: DragEvent, dropKey: string) => {
    if (![...event.dataTransfer.types].includes("text/omnipanel-docker-sidebar")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDragOverKey(dropKey);
  };

  const onDropOnFolder = (event: DragEvent, folderId: string) => {
    event.preventDefault();
    event.stopPropagation();
    setDragOverKey(null);
    const nodeKey = event.dataTransfer.getData("text/omnipanel-docker-sidebar");
    if (!nodeKey) return;
    moveNode({ nodeKey, targetParentId: folderId });
    ensureExpanded(`docker-folder:${folderId}`);
  };

  const onDropBefore = (event: DragEvent, parentId: string | null, beforeKey: string) => {
    event.preventDefault();
    event.stopPropagation();
    setDragOverKey(null);
    const nodeKey = event.dataTransfer.getData("text/omnipanel-docker-sidebar");
    if (!nodeKey || nodeKey === beforeKey) return;
    moveNode({ nodeKey, targetParentId: parentId, beforeKey });
  };

  const renderConnection = (connection: DockerConnectionInfo, depth: number) => {
    const connectionKey = makeDockerTreeKey(connection.connectionId);
    const connectionExpanded = isExpanded(connectionKey);
    const supportsResources = connectionSupportsSidebarResources(connection);
    const connectionIconKind = dockerConnectionIconKind(connection.source);
    const dragKey = dockerSidebarConnectionNodeKey(connection.connectionId);
    return (
      <div key={connection.connectionId} className="server-tree-server docker-tree-connection">
        <SidebarTreeNode
          depth={depth}
          module="docker"
          nodeType="connection"
          treeKey={connectionKey}
          icon={<DockerTreeIcon kind={connectionIconKind} />}
          className={`${dockerTreeNodeClassName(connectionIconKind)}${
            dragOverKey === dragKey ? " docker-tree-drop-target" : ""
          }`}
          shouldIgnoreClick={(target) =>
            Boolean((target as HTMLElement | null)?.closest(".tree-action-btn"))
          }
          draggable={!isBuiltinLocalDockerConnection(connection.connectionId)}
          onDragStart={(e) => onDragStartNode(e, dragKey)}
          onDragOver={(e) => onDragOverNode(e, dragKey)}
          onDragLeave={() => setDragOverKey((k) => (k === dragKey ? null : k))}
          onDrop={(e) => {
            const parentId = connectionFolderId[connection.connectionId] ?? null;
            onDropBefore(e, parentId, dragKey);
          }}
          onDragEnd={() => setDragOverKey(null)}
          prefix={
            <StatusDot
              status={statusDotStatus(connection.status)}
              title={
                connection.status === "online"
                  ? t("docker.sidebar.statusOnline")
                  : connection.status === "degraded"
                    ? t("docker.sidebar.statusDegraded")
                    : t("docker.sidebar.statusOffline")
              }
            />
          }
          label={
            <span className="server-tree-server-label">
              <span className="server-tree-server-name">{connection.name}</span>
              <span className="badge badge-muted docker-tree-source-tag">
                {dockerSourceLabel(connection.source)}
              </span>
            </span>
          }
          hasChildren
          expanded={connectionExpanded}
          active={activeNavKey === connectionKey || activeConnectionId === connection.connectionId}
          onToggle={() => toggle(connectionKey)}
          onSelect={() => onNavigate({ connectionId: connection.connectionId }, "preview")}
          onActivate={() => onNavigate({ connectionId: connection.connectionId }, "permanent")}
          onContextMenu={(event) => openCtx(event, { kind: "connection", connection })}
          trailing={
            supportsResources ? (
              <div className="tree-node-actions">
                <DockerTreeRefreshButton
                  refreshKey={dockerSidebarConnectionRefreshKey(connection.connectionId)}
                  onRefresh={() => refreshDockerConnectionSidebarCache(connection.connectionId)}
                />
              </div>
            ) : null
          }
        />
        <DockerTreeBranch
          connection={connection}
          connectionExpanded={connectionExpanded}
          activeNavKey={activeNavKey}
          searchQuery={searchQuery}
          isExpanded={isExpanded}
          toggle={toggle}
          ensureExpanded={ensureExpanded}
          onNavigate={onNavigate}
        />
      </div>
    );
  };

  const renderFolderTree = (parentId: string | null, depth: number): ReactNode => {
    const items = listDockerSidebarChildren(
      { folders, orderByParent, connectionFolderId },
      parentId,
      connectionIds,
    );
    return items.map((item) => {
      if (item.kind === "connection") {
        const connection = connectionById.get(item.connectionId);
        if (!connection) return null;
        return renderConnection(connection, depth);
      }
      const folder = item.folder;
      const folderTreeKey = `docker-folder:${folder.id}`;
      const folderExpanded = isExpanded(folderTreeKey);
      const dropKey = dockerSidebarFolderNodeKey(folder.id);
      return (
        <div key={folder.id} className="docker-tree-folder">
          <SidebarTreeNode
            depth={depth}
            module="docker"
            nodeType="folder"
            treeKey={folderTreeKey}
            icon={<FolderIcon />}
            className={dragOverKey === dropKey ? "docker-tree-drop-target" : ""}
            label={folder.name}
            hasChildren
            expanded={folderExpanded}
            draggable
            onDragStart={(e) => onDragStartNode(e, dropKey)}
            onDragOver={(e) => onDragOverNode(e, dropKey)}
            onDragLeave={() => setDragOverKey((k) => (k === dropKey ? null : k))}
            onDrop={(e) => onDropOnFolder(e, folder.id)}
            onDragEnd={() => setDragOverKey(null)}
            onToggle={() => toggle(folderTreeKey)}
            onContextMenu={(event) => openCtx(event, { kind: "folder", folder })}
            onRename={() => handleRenameFolder(folder)}
            onDelete={() => deleteFolder(folder.id)}
            renameLabel={t("docker.sidebar.renameFolder")}
            deleteLabel={t("docker.sidebar.deleteFolder")}
          />
          {folderExpanded ? renderFolderTree(folder.id, depth + 1) : null}
        </div>
      );
    });
  };

  const addConnectionButton = (
    <div className="schema-toolbar schema-toolbar--inline">
      {onImportFromSsh && (
        <Button
          type="button"
          variant="icon"
          className="server-sidebar-group-add"
          title={t("docker.sidebar.importFromSsh")}
          disabled={importingFromSsh}
          onClick={onImportFromSsh}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M12 3v12" />
            <path d="M8 11l4 4 4-4" />
            <path d="M4 19h16" />
          </svg>
        </Button>
      )}
      {onRefreshAll && (
        <Button
          type="button"
          variant="icon"
          className={`server-sidebar-group-add${refreshingAll ? " tree-action-btn--busy" : ""}`}
          title={t("docker.sidebar.refreshAll")}
          disabled={refreshingAll || connections.length === 0}
          onClick={onRefreshAll}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M2 8a6 6 0 0 1 10.5-3.9" />
            <path d="M14 2v3h-3" />
            <path d="M14 8a6 6 0 0 1-10.5 3.9" />
            <path d="M2 14v-3h3" />
          </svg>
        </Button>
      )}
      <Button
        type="button"
        variant="icon"
        className="server-sidebar-add"
        title={t("docker.sidebar.addConnection")}
        onClick={onCreate}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </Button>
    </div>
  );

  const panelBody = (
    <>
      <SidebarTreeSelectionProvider
        orderedKeys={allTreeKeys}
        onSelectedIdsChange={handleSelectedIdsChange}
      >
        <DockerTreeHotkeys
          allKeys={allTreeKeys}
          armedRef={sidebarHotkeysArmedRef}
          onDeleteSelected={handleHotkeyDelete}
        />
        <div
          className="docker-sidebar-tree-wrap"
          onContextMenu={(event) => {
            if ((event.target as HTMLElement).closest(".sidebar-tree-node, .tree-node")) return;
            openCtx(event, { kind: "blank" });
          }}
        >
          <SidebarTreeRoot className="server-sidebar-body docker-sidebar-tree">
            {loading && filteredConnections.length === 0 ? (
              <SidebarTreeEmpty>{t("docker.sidebar.loading")}</SidebarTreeEmpty>
            ) : filteredConnections.length === 0 && folders.length === 0 ? (
              <SidebarTreeEmpty>
                {searching ? t("docker.sidebar.searchNoResults") : t("docker.sidebar.empty")}
              </SidebarTreeEmpty>
            ) : searching ? (
              filteredConnections.map((connection) => renderConnection(connection, 0))
            ) : (
              renderFolderTree(null, 0)
            )}
          </SidebarTreeRoot>
        </div>
      </SidebarTreeSelectionProvider>
      {ctxPos ? (
        <ContextMenu items={ctxItems} position={ctxPos} onClose={() => setCtxPos(null)} />
      ) : null}
    </>
  );

  if (section) {
    return (
      <div ref={rootRef} className="server-sidebar docker-sidebar">
        <VerticalSplitSidebarSection
          {...section}
          actions={
            <>
              <span className="badge badge-muted">{connections.length}</span>
              {addConnectionButton}
            </>
          }
        >
          {panelBody}
        </VerticalSplitSidebarSection>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="server-sidebar docker-sidebar">
      <div className="server-sidebar-subheader window-drag-surface" data-tauri-drag-region>
        <span>{t("docker.sidebar.title")}</span>
        <span className="badge badge-muted">{connections.length}</span>
        {addConnectionButton}
      </div>
      {panelBody}
    </div>
  );
}
