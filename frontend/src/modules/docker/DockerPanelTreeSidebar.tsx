import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { useI18n } from "@/i18n";
import { ContextMenu, type ContextMenuItem } from "@/components/ui/ContextMenu";
import { Button } from "@/components/ui/Button";
import {
  VerticalSplitSidebarSection,
  type VerticalSplitSidebarSectionConfig,
} from "@/components/ui/VerticalSplitSidebar";
import { SidebarTreeEmpty, SidebarTreeNode, SidebarTreeRoot, SidebarTreeSelectionProvider } from "@/components/ui/sidebar-tree";
import type { DockerConnectionInfo } from "@/ipc/bindings";
import { isBuiltinLocalDockerConnection } from "./constants";
import type { DockerConnectionDockOpenMode } from "./dockerConnectionWorkspaceTabs";
import {
  containerRowLabel,
  imageRowLabel,
  imageRowSizeLabel,
  makeDockerComposeProjectTreeKey,
  makeDockerTreeKey,
  networkRowLabel,
  volumeRowLabel,
} from "./dockerResourceLabels";
import {
  DOCKER_TREE_CATEGORIES,
  type DockerSidebarNavigate,
  type DockerTreeCategory,
} from "./dockerSidebarNav";
import {
  DockerTreeIcon,
  dockerCategoryIconKind,
  dockerItemIconKind,
  dockerTreeNodeClassName,
} from "./dockerTreeIcons";
import {
  connectionSupportsSidebarResources,
  refreshDockerConnectionSidebarCache,
  useDockerConnectionResources,
} from "./hooks/useDockerConnectionResources";
import { DockerContainersTreeBranch } from "./DockerContainersTreeBranch";
import { DockerSidebarExpandableLeaves } from "./DockerSidebarExpandableLeaves";
import { dockerSourceLabel } from "./dockerConnectionSource";
import { groupContainersByComposeProject } from "./dockerComposeGroups";
import { usePersistedDockerTreeExpanded } from "./usePersistedDockerTreeExpanded";
import { DockerTreeRefreshButton } from "./DockerTreeRefreshButton";
import {
  dockerSidebarCategoryRefreshKey,
  dockerSidebarConnectionRefreshKey,
} from "./dockerSidebarCache";
import { hasSidebarTreeSearch, sidebarTreeSearchMatches } from "@/lib/sidebarTreeSearch";
import { useDockerSidebarCacheStore } from "@/stores/dockerSidebarCacheStore";
import {
  dockerConnectionNameMatchesSearch,
  dockerConnectionSubtreeMatchesSearch,
  dockerComposeProjectMatchesSearch,
} from "./dockerTreeSearch";

function statusDotClass(status: DockerConnectionInfo["status"]): string {
  if (status === "online") return "online";
  if (status === "degraded") return "warning";
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
  // 始终订阅缓存（折叠时也能留给搜索/徽章）；仅在展开且尚无缓存时首拉
  const { images, containers, networks, volumes, loading, error, refreshCategory } =
    useDockerConnectionResources(supportsResources ? connection : null, {
      autoFetchWhenEmpty: connectionExpanded,
    });
  const connectionNameMatch = dockerConnectionNameMatchesSearch(searchQuery, connection);

  const categoryItems = useMemo(() => {
    type TreeItem = { id: string; label: string; meta?: string };
    const itemBuilders: Record<DockerTreeCategory, () => TreeItem[]> = {
      images: () =>
        images.map((image) => ({
          id: image.id,
          label: imageRowLabel(image),
          meta: imageRowSizeLabel(image),
        })),
      containers: () =>
        containers.map((container) => ({
          id: container.id,
          label: containerRowLabel(container),
        })),
      networks: () =>
        networks.map((network) => ({
          id: network.name,
          label: networkRowLabel(network),
        })),
      volumes: () =>
        volumes.map((volume) => ({
          id: volume.name,
          label: volumeRowLabel(volume),
        })),
    };

    const filterItems = (category: DockerTreeCategory, items: TreeItem[]) => {
      if (!hasSidebarTreeSearch(searchQuery) || connectionNameMatch) {
        return items;
      }
      const categoryLabel = t(`docker.tabs.${category}`);
      if (sidebarTreeSearchMatches(searchQuery, categoryLabel)) {
        return items;
      }
      return items.filter((item) => sidebarTreeSearchMatches(searchQuery, item.label, item.meta));
    };

    return DOCKER_TREE_CATEGORIES.map((id) => {
      const items = filterItems(id, itemBuilders[id]());
      return {
        id,
        label: t(`docker.tabs.${id}`),
        count: items.length,
        items,
      };
    }).filter((category) => {
      if (!hasSidebarTreeSearch(searchQuery) || connectionNameMatch) {
        return true;
      }
      if (sidebarTreeSearchMatches(searchQuery, category.label)) {
        return true;
      }
      return category.items.length > 0;
    });
  }, [connectionNameMatch, containers, images, networks, searchQuery, t, volumes]);

  useEffect(() => {
    if (!hasSidebarTreeSearch(searchQuery)) {
      return;
    }
    ensureExpanded(makeDockerTreeKey(connection.connectionId));
    for (const category of categoryItems) {
      ensureExpanded(makeDockerTreeKey(connection.connectionId, category.id));
    }
    for (const group of groupContainersByComposeProject(containers)) {
      if (dockerComposeProjectMatchesSearch(searchQuery, group.project, group.containers)) {
        ensureExpanded(makeDockerComposeProjectTreeKey(connection.connectionId, group.project));
      }
    }
  }, [categoryItems, connection.connectionId, containers, ensureExpanded, searchQuery]);

  if (!connectionExpanded) return null;

  if (!supportsResources) {
    return (
      <SidebarTreeEmpty style={{ paddingLeft: 28 }}>
        {t("docker.sidebar.treeUnsupported")}
      </SidebarTreeEmpty>
    );
  }

  return (
    <>
      {categoryItems.map((category) => {
        const categoryKey = makeDockerTreeKey(connection.connectionId, category.id);
        const categoryExpanded = isExpanded(categoryKey);
        const openCategory = (mode?: DockerConnectionDockOpenMode) => {
          ensureExpanded(makeDockerTreeKey(connection.connectionId));
          ensureExpanded(categoryKey);
          onNavigate({ connectionId: connection.connectionId, category: category.id }, mode);
        };

        return (
          <div key={category.id} className="server-tree-category">
            <SidebarTreeNode
              depth={1}
              module="docker"
              nodeType={category.id}
              treeKey={categoryKey}
              label={category.label}
              icon={<DockerTreeIcon kind={dockerCategoryIconKind(category.id)} />}
              className={dockerTreeNodeClassName(dockerCategoryIconKind(category.id))}
              hasChildren
              expanded={categoryExpanded}
              active={activeNavKey === categoryKey}
              onToggle={() => toggle(categoryKey)}
              onActivate={() => openCategory("permanent")}
              trailing={
                <>
                  {loading && category.items.length === 0 ? (
                    <span className="server-tree-badge">…</span>
                  ) : (
                    <span className="server-tree-badge">{category.count}</span>
                  )}
                  <div className="tree-node-actions">
                    <DockerTreeRefreshButton
                      refreshKey={dockerSidebarCategoryRefreshKey(connection.connectionId, category.id)}
                      onRefresh={() => refreshCategory(category.id)}
                    />
                  </div>
                </>
              }
            />
            {categoryExpanded ? (
              <div className="server-tree-children">
                {category.id === "containers" ? (
                  <DockerContainersTreeBranch
                    connection={connection}
                    containers={containers}
                    categoryKey={categoryKey}
                    activeNavKey={activeNavKey}
                    searchQuery={searchQuery}
                    connectionNameMatch={connectionNameMatch}
                    loading={loading}
                    error={error}
                    isExpanded={isExpanded}
                    toggle={toggle}
                    ensureExpanded={ensureExpanded}
                    onNavigate={onNavigate}
                    onRefreshCategory={() => refreshCategory("containers")}
                  />
                ) : loading && category.items.length === 0 ? (
                  <SidebarTreeEmpty>{t("docker.sidebar.treeLoading")}</SidebarTreeEmpty>
                ) : error && category.items.length === 0 ? (
                  <SidebarTreeEmpty>{error}</SidebarTreeEmpty>
                ) : category.items.length === 0 ? (
                  <SidebarTreeEmpty>{t("docker.sidebar.treeEmpty")}</SidebarTreeEmpty>
                ) : (
                  <DockerSidebarExpandableLeaves
                    items={category.items}
                    getKey={(item) => `${category.id}:${item.id}:${item.label}`}
                    renderItem={(item) => {
                    const itemKey = makeDockerTreeKey(connection.connectionId, category.id, item.id);
                    const openItem = (mode?: DockerConnectionDockOpenMode) => {
                      ensureExpanded(makeDockerTreeKey(connection.connectionId));
                      ensureExpanded(categoryKey);
                      onNavigate(
                        {
                          connectionId: connection.connectionId,
                          category: category.id,
                          itemId: item.id,
                        },
                        mode,
                      );
                    };
                    return (
                      <SidebarTreeNode
                        depth={2}
                        module="docker"
                        nodeType={category.id}
                        treeKey={itemKey}
                        label={item.label}
                        icon={<DockerTreeIcon kind={dockerItemIconKind(category.id)} />}
                        className={dockerTreeNodeClassName(dockerItemIconKind(category.id))}
                        hasChildren={false}
                        expanded={false}
                        active={activeNavKey === itemKey}
                        shouldIgnoreClick={(target) =>
                          Boolean((target as HTMLElement | null)?.closest(".tree-action-btn"))
                        }
                        onToggle={() => {}}
                        onActivate={() => openItem("permanent")}
                        trailing={
                          <>
                            {item.meta ? (
                              <span className="server-tree-badge docker-tree-image-size" title={item.meta}>
                                {item.meta}
                              </span>
                            ) : null}
                            <div className="tree-node-actions">
                              <DockerTreeRefreshButton
                                refreshKey={dockerSidebarCategoryRefreshKey(connection.connectionId, category.id)}
                                onRefresh={() => refreshCategory(category.id)}
                              />
                            </div>
                          </>
                        }
                      />
                    );
                    }}
                  />
                )}
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

export interface DockerPanelTreeSidebarProps {
  connections: DockerConnectionInfo[];
  activeConnectionId: string | null;
  activeNavKey: string | null;
  searchQuery?: string;
  loading?: boolean;
  scanning?: boolean;
  onNavigate: DockerSidebarNavigate;
  onCreate?: () => void;
  onScan?: () => void;
  onEditConnection?: (connection: DockerConnectionInfo) => void;
  onDeleteConnection?: (connectionId: string) => void;
  section?: VerticalSplitSidebarSectionConfig;
}

export function DockerPanelTreeSidebar({
  connections,
  activeConnectionId,
  activeNavKey,
  searchQuery = "",
  loading,
  scanning,
  onNavigate,
  onCreate,
  onScan,
  onEditConnection,
  onDeleteConnection,
  section,
}: DockerPanelTreeSidebarProps) {
  const { t } = useI18n();
  const { isExpanded, toggle, ensureExpanded } = usePersistedDockerTreeExpanded();
  const [ctxPos, setCtxPos] = useState<{ x: number; y: number } | null>(null);
  const [ctxConnection, setCtxConnection] = useState<DockerConnectionInfo | null>(null);

  useEffect(() => {
    if (!activeConnectionId) return;
    ensureExpanded(makeDockerTreeKey(activeConnectionId));
  }, [activeConnectionId, ensureExpanded]);

  const sortedConnections = useMemo(
    () => [...connections].sort((a, b) => a.name.localeCompare(b.name)),
    [connections],
  );

  const categoryLabels = useMemo(
    () =>
      Object.fromEntries(
        DOCKER_TREE_CATEGORIES.map((category) => [category, t(`docker.tabs.${category}`)]),
      ) as Record<DockerTreeCategory, string>,
    [t],
  );

  const cacheConnections = useDockerSidebarCacheStore((state) => state.connections);

  const filteredConnections = useMemo(() => {
    if (!hasSidebarTreeSearch(searchQuery)) {
      return sortedConnections;
    }
    return sortedConnections.filter((connection) => {
      const entry = useDockerSidebarCacheStore.getState().getEntry(connection.connectionId);
      return dockerConnectionSubtreeMatchesSearch(
        searchQuery,
        connection,
        entry,
        categoryLabels,
      );
    });
  }, [cacheConnections, categoryLabels, searchQuery, sortedConnections]);

  useEffect(() => {
    if (!hasSidebarTreeSearch(searchQuery)) {
      return;
    }
    for (const connection of filteredConnections) {
      ensureExpanded(makeDockerTreeKey(connection.connectionId));
    }
  }, [ensureExpanded, filteredConnections, searchQuery]);

  const handleContextMenu = (event: MouseEvent, connection: DockerConnectionInfo) => {
    if (isBuiltinLocalDockerConnection(connection.connectionId)) return;
    event.preventDefault();
    setCtxPos({ x: event.clientX, y: event.clientY });
    setCtxConnection(connection);
  };

  const ctxItems: ContextMenuItem[] = [
    {
      id: "edit",
      label: t("docker.sidebar.edit"),
      onClick: () => ctxConnection && onEditConnection?.(ctxConnection),
    },
    {
      id: "delete",
      label: t("docker.sidebar.delete"),
      danger: true,
      onClick: () => ctxConnection && onDeleteConnection?.(ctxConnection.connectionId),
    },
  ];

  const addConnectionButton = (
    <div className="schema-toolbar schema-toolbar--inline">
      {onScan && (
        <Button
          type="button"
          variant="icon"
          className="server-sidebar-group-add"
          title={t("docker.sidebar.scanSsh")}
          disabled={scanning}
          onClick={onScan}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M23 4v6h-6" />
            <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
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
      <SidebarTreeSelectionProvider>
      <SidebarTreeRoot className="server-sidebar-body docker-sidebar-tree">
        {loading ? (
          <SidebarTreeEmpty>{t("docker.sidebar.loading")}</SidebarTreeEmpty>
        ) : filteredConnections.length === 0 ? (
          <SidebarTreeEmpty>
            {hasSidebarTreeSearch(searchQuery)
              ? t("docker.sidebar.searchNoResults")
              : t("docker.sidebar.empty")}
          </SidebarTreeEmpty>
        ) : (
          filteredConnections.map((connection) => {
            const connectionKey = makeDockerTreeKey(connection.connectionId);
            const connectionExpanded = isExpanded(connectionKey);
            const supportsResources = connectionSupportsSidebarResources(connection);
            return (
              <div key={connection.connectionId} className="server-tree-server docker-tree-connection">
                <SidebarTreeNode
                  depth={0}
                  module="docker"
                  nodeType="connection"
                  treeKey={connectionKey}
                  icon={<DockerTreeIcon kind="connection" />}
                  className={dockerTreeNodeClassName("connection")}
                  shouldIgnoreClick={(target) =>
                    Boolean((target as HTMLElement | null)?.closest(".tree-action-btn"))
                  }
                  label={
                    <span className="server-tree-server-label">
                      <span className="server-tree-server-name">{connection.name}</span>
                      <span className={`status-dot ${statusDotClass(connection.status)}`} />
                      <span className="badge badge-muted docker-tree-source-tag">
                        {dockerSourceLabel(connection.source)}
                      </span>
                    </span>
                  }
                  hasChildren
                  expanded={connectionExpanded}
                  active={
                    activeNavKey === connectionKey || activeConnectionId === connection.connectionId
                  }
                  onToggle={() => toggle(connectionKey)}
                  onActivate={() =>
                    onNavigate({ connectionId: connection.connectionId }, "permanent")
                  }
                  onContextMenu={(event) => handleContextMenu(event, connection)}
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
          })
        )}
      </SidebarTreeRoot>
      </SidebarTreeSelectionProvider>
      {ctxPos ? (
        <ContextMenu items={ctxItems} position={ctxPos} onClose={() => setCtxPos(null)} />
      ) : null}
    </>
  );

  if (section) {
    return (
      <div className="server-sidebar docker-sidebar">
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
    <div className="server-sidebar docker-sidebar">
      <div className="server-sidebar-subheader window-drag-surface" data-tauri-drag-region>
        <span>{t("docker.sidebar.title")}</span>
        <span className="badge badge-muted">{connections.length}</span>
        {addConnectionButton}
      </div>
      {panelBody}
    </div>
  );
}
