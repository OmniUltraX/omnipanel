import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { useI18n } from "@/i18n";
import { ContextMenu, type ContextMenuItem } from "@/components/ui/ContextMenu";
import { Button } from "@/components/ui/Button";
import {
  VerticalSplitSidebarSection,
  type VerticalSplitSidebarSectionConfig,
} from "@/components/ui/VerticalSplitSidebar";
import { SidebarTreeEmpty, SidebarTreeNode, SidebarTreeRoot } from "@/components/ui/sidebar-tree";
import type { DockerConnectionInfo } from "@/ipc/bindings";
import { isBuiltinLocalDockerConnection } from "./constants";
import type { DockerConnectionDockOpenMode } from "./dockerConnectionWorkspaceTabs";
import {
  containerRowLabel,
  imageRowLabel,
  makeDockerServiceGroupTreeKey,
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
import { dockerSourceLabel } from "./dockerConnectionSource";
import { usePersistedDockerTreeExpanded } from "./usePersistedDockerTreeExpanded";
import { useDockerServiceGroupStore } from "@/stores/dockerServiceGroupStore";
import { quickInput } from "@/stores/quickInputStore";
import { DockerTreeRefreshButton } from "./DockerTreeRefreshButton";
import {
  dockerSidebarCategoryRefreshKey,
  dockerSidebarConnectionRefreshKey,
} from "./dockerSidebarCache";

function statusDotClass(status: DockerConnectionInfo["status"]): string {
  if (status === "online") return "online";
  if (status === "degraded") return "warning";
  return "offline";
}

type DockerTreeBranchProps = {
  connection: DockerConnectionInfo;
  connectionExpanded: boolean;
  activeNavKey: string | null;
  isExpanded: (key: string) => boolean;
  toggle: (key: string) => void;
  ensureExpanded: (key: string) => void;
  onNavigate: DockerSidebarNavigate;
};

function DockerTreeBranch({
  connection,
  connectionExpanded,
  activeNavKey,
  isExpanded,
  toggle,
  ensureExpanded,
  onNavigate,
}: DockerTreeBranchProps) {
  const { t } = useI18n();
  const loadConnection =
    connectionExpanded && connectionSupportsSidebarResources(connection) ? connection : null;
  const { images, containers, networks, volumes, loading, error, refreshCategory } =
    useDockerConnectionResources(loadConnection);
  const createServiceGroup = useDockerServiceGroupStore((state) => state.createGroup);

  const handleCreateServiceGroup = async (categoryKey: string) => {
    const name = await quickInput({
      title: t("docker.sidebar.newServiceGroup"),
      subtitle: t("docker.sidebar.serviceGroupPrompt"),
      placeholder: t("docker.sidebar.serviceGroupPrompt"),
    });
    if (!name?.trim()) return;
    const groupId = createServiceGroup(connection.connectionId, name);
    if (!groupId) return;
    ensureExpanded(makeDockerTreeKey(connection.connectionId));
    ensureExpanded(categoryKey);
    ensureExpanded(makeDockerServiceGroupTreeKey(connection.connectionId, groupId));
    onNavigate(
      {
        connectionId: connection.connectionId,
        category: "containers",
        serviceGroupId: groupId,
      },
      "permanent",
    );
  };

  const categoryItems = useMemo(() => {
    const itemBuilders: Record<
      DockerTreeCategory,
      () => Array<{ id: string; label: string }>
    > = {
      images: () => images.map((image) => ({ id: image.id, label: imageRowLabel(image) })),
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

    return DOCKER_TREE_CATEGORIES.map((id) => ({
      id,
      label: t(`docker.tabs.${id}`),
      count: itemBuilders[id]().length,
      items: itemBuilders[id](),
    }));
  }, [containers, images, networks, volumes, t]);

  if (!connectionExpanded) return null;

  if (!connectionSupportsSidebarResources(connection)) {
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
              label={category.label}
              icon={<DockerTreeIcon kind={dockerCategoryIconKind(category.id)} />}
              className={dockerTreeNodeClassName(dockerCategoryIconKind(category.id))}
              hasChildren
              expanded={categoryExpanded}
              active={activeNavKey === categoryKey}
              onToggle={() => toggle(categoryKey)}
              onClick={() => openCategory("preview")}
              onDoubleClick={() => openCategory("permanent")}
              shouldIgnoreClick={(target) =>
                Boolean((target as HTMLElement | null)?.closest(".docker-tree-node-action"))
              }
              trailing={
                <span className="docker-tree-category-trailing">
                  {loading && category.items.length === 0 ? (
                    <span className="server-tree-badge">…</span>
                  ) : (
                    <span className="server-tree-badge">{category.count}</span>
                  )}
                  <DockerTreeRefreshButton
                    refreshKey={dockerSidebarCategoryRefreshKey(connection.connectionId, category.id)}
                    onRefresh={() => refreshCategory(category.id)}
                  />
                  {category.id === "containers" ? (
                    <Button
                      type="button"
                      variant="icon"
                      size="icon-xs"
                      className="docker-tree-node-action"
                      title={t("docker.sidebar.newServiceGroup")}
                      aria-label={t("docker.sidebar.newServiceGroup")}
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleCreateServiceGroup(categoryKey);
                      }}
                    >
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        aria-hidden
                      >
                        <path d="M12 5v14M5 12h14" />
                      </svg>
                    </Button>
                  ) : null}
                </span>
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
                  category.items.map((item) => {
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
                        key={item.id}
                        depth={2}
                        label={item.label}
                        icon={<DockerTreeIcon kind={dockerItemIconKind(category.id)} />}
                        className={dockerTreeNodeClassName(dockerItemIconKind(category.id))}
                        hasChildren={false}
                        expanded={false}
                        active={activeNavKey === itemKey}
                        shouldIgnoreClick={(target) =>
                          Boolean((target as HTMLElement | null)?.closest(".docker-tree-node-action"))
                        }
                        onToggle={() => {}}
                        onClick={() => openItem("preview")}
                        onDoubleClick={() => openItem("permanent")}
                        trailing={
                          <DockerTreeRefreshButton
                            refreshKey={dockerSidebarCategoryRefreshKey(connection.connectionId, category.id)}
                            onRefresh={() => refreshCategory(category.id)}
                          />
                        }
                      />
                    );
                  })
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
      <SidebarTreeRoot className="server-sidebar-body docker-sidebar-tree">
        {loading ? (
          <SidebarTreeEmpty>{t("docker.sidebar.loading")}</SidebarTreeEmpty>
        ) : sortedConnections.length === 0 ? (
          <SidebarTreeEmpty>{t("docker.sidebar.empty")}</SidebarTreeEmpty>
        ) : (
          sortedConnections.map((connection) => {
            const connectionKey = makeDockerTreeKey(connection.connectionId);
            const connectionExpanded = isExpanded(connectionKey);
            const supportsResources = connectionSupportsSidebarResources(connection);
            return (
              <div key={connection.connectionId} className="server-tree-server docker-tree-connection">
                <SidebarTreeNode
                  depth={0}
                  icon={<DockerTreeIcon kind="connection" />}
                  className={dockerTreeNodeClassName("connection")}
                  shouldIgnoreClick={(target) =>
                    Boolean((target as HTMLElement | null)?.closest(".docker-tree-node-action"))
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
                  onClick={() => onNavigate({ connectionId: connection.connectionId }, "preview")}
                  onDoubleClick={() =>
                    onNavigate({ connectionId: connection.connectionId }, "permanent")
                  }
                  onContextMenu={(event) => handleContextMenu(event, connection)}
                  trailing={
                    supportsResources ? (
                      <DockerTreeRefreshButton
                        refreshKey={dockerSidebarConnectionRefreshKey(connection.connectionId)}
                        onRefresh={() => refreshDockerConnectionSidebarCache(connection.connectionId)}
                      />
                    ) : null
                  }
                />
                <DockerTreeBranch
                  connection={connection}
                  connectionExpanded={connectionExpanded}
                  activeNavKey={activeNavKey}
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
