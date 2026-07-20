import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { useI18n } from "@/i18n";
import { ContextMenu, type ContextMenuItem } from "@/components/ui/ContextMenu";
import { Button } from "@/components/ui/Button";
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
} from "@/components/ui/sidebar-tree";
import type { DockerConnectionInfo } from "@/ipc/bindings";
import { isBuiltinLocalDockerConnection } from "./constants";
import {
  makeDockerComposeProjectTreeKey,
  makeDockerTreeKey,
} from "./dockerResourceLabels";
import type { DockerSidebarNavigate } from "./dockerSidebarNav";
import { DockerTreeIcon, dockerTreeNodeClassName } from "./dockerTreeIcons";
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
import { useDockerSidebarCacheStore } from "@/stores/dockerSidebarCacheStore";
import {
  dockerConnectionNameMatchesSearch,
  dockerConnectionSubtreeMatchesSearch,
  dockerComposeProjectMatchesSearch,
} from "./dockerTreeSearch";

function statusDotClass(status: DockerConnectionInfo["status"]): string {
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
  // 始终订阅缓存；展开只展示 Compose/容器树，拉数仅靠节点刷新按钮
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

export interface DockerPanelTreeSidebarProps {
  connections: DockerConnectionInfo[];
  activeConnectionId: string | null;
  activeNavKey: string | null;
  searchQuery?: string;
  loading?: boolean;
  refreshingAll?: boolean;
  onNavigate: DockerSidebarNavigate;
  onCreate?: () => void;
  /** 刷新列表中全部连接的侧栏资源缓存 */
  onRefreshAll?: () => void;
  onEditConnection?: (connection: DockerConnectionInfo) => void;
  onDeleteConnection?: (connectionIds: string | string[]) => void;
  section?: VerticalSplitSidebarSectionConfig;
}

export function DockerPanelTreeSidebar({
  connections,
  activeConnectionId,
  activeNavKey,
  searchQuery = "",
  loading,
  refreshingAll,
  onNavigate,
  onCreate,
  onRefreshAll,
  onEditConnection,
  onDeleteConnection,
  section,
}: DockerPanelTreeSidebarProps) {
  const { t } = useI18n();
  const { isExpanded, toggle, ensureExpanded } = usePersistedDockerTreeExpanded();
  const [ctxPos, setCtxPos] = useState<{ x: number; y: number } | null>(null);
  const [ctxConnection, setCtxConnection] = useState<DockerConnectionInfo | null>(null);
  const selectedIdsRef = useRef<ReadonlySet<string>>(new Set());
  const handleSelectedIdsChange = useCallback((ids: ReadonlySet<string>) => {
    selectedIdsRef.current = ids;
  }, []);

  useEffect(() => {
    if (!activeConnectionId) return;
    ensureExpanded(makeDockerTreeKey(activeConnectionId));
  }, [activeConnectionId, ensureExpanded]);

  const sortedConnections = useMemo(
    () => [...connections].sort((a, b) => a.name.localeCompare(b.name)),
    [connections],
  );

  const cacheConnections = useDockerSidebarCacheStore((state) => state.connections);

  const filteredConnections = useMemo(() => {
    if (!hasSidebarTreeSearch(searchQuery)) {
      return sortedConnections;
    }
    return sortedConnections.filter((connection) => {
      const entry = useDockerSidebarCacheStore.getState().getEntry(connection.connectionId);
      return dockerConnectionSubtreeMatchesSearch(searchQuery, connection, entry);
    });
  }, [cacheConnections, searchQuery, sortedConnections]);

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

  const connectionKeyById = useMemo(() => {
    const map = new Map<string, string>();
    for (const connection of connections) {
      map.set(makeDockerTreeKey(connection.connectionId), connection.connectionId);
    }
    return map;
  }, [connections]);

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
      onClick: () => {
        if (!ctxConnection || !onDeleteConnection) return;
        const clickedKey = makeDockerTreeKey(ctxConnection.connectionId);
        const keys = resolveSidebarTreeDeleteTargets(clickedKey, selectedIdsRef.current, {
          filter: (id) => connectionKeyById.has(id) && !isBuiltinLocalDockerConnection(connectionKeyById.get(id)!),
        });
        const ids = keys
          .map((key) => connectionKeyById.get(key))
          .filter((id): id is string => Boolean(id));
        if (ids.length === 0) return;
        onDeleteConnection(ids.length === 1 ? ids[0]! : ids);
      },
    },
  ];

  const addConnectionButton = (
    <div className="schema-toolbar schema-toolbar--inline">
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
      <SidebarTreeSelectionProvider onSelectedIdsChange={handleSelectedIdsChange}>
      <SidebarTreeRoot className="server-sidebar-body docker-sidebar-tree">
        {loading && filteredConnections.length === 0 ? (
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
                  prefix={
                    <span
                      className={`topbar-tab-dot ${statusDotClass(connection.status)}`}
                      title={
                        connection.status === "online"
                          ? t("docker.sidebar.statusOnline")
                          : connection.status === "degraded"
                            ? t("docker.sidebar.statusDegraded")
                            : t("docker.sidebar.statusOffline")
                      }
                      aria-hidden
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
