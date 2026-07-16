import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { useI18n } from "@/i18n";
import { ContextMenu, type ContextMenuItem } from "@/components/ui/ContextMenu";
import { Button } from "@/components/ui/Button";
import { IconRefresh } from "@/components/ui/Icons";
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
import { useConnectionStore } from "@/stores/connectionStore";
import { useServerPanelCacheStore } from "@/stores/serverPanelCacheStore";
import type { ServerEntry } from "./serverConnection";
import { usePersistedServerTreeExpanded } from "./usePersistedServerTreeExpanded";
import {
  makeServerTreeKey,
  serverSupportsResources,
} from "./serverResourceLabels";
import type { ServerSidebarNavigate } from "./serverSidebarNav";
import { hasSidebarTreeSearch, sidebarTreeSearchMatches } from "@/lib/sidebarTreeSearch";
import { serverEntryMatchesSearch } from "../serverTreeSearch";
import { ServerTreeIcon, serverTreeNodeClassName } from "./serverTreeIcons";

type ServerTreeBranchProps = {
  server: ServerEntry;
  serverExpanded: boolean;
  activeNavKey: string | null;
  searchQuery: string;
  ensureExpanded: (key: string) => void;
  onNavigate: ServerSidebarNavigate;
};

const SERVER_TREE_CATEGORIES = ["websites", "certificates", "cronjobs"] as const;

function ServerTreeBranch({
  server,
  serverExpanded,
  activeNavKey,
  searchQuery,
  ensureExpanded,
  onNavigate,
}: ServerTreeBranchProps) {
  const { t } = useI18n();
  const serviceTypeLabel = t(`server.serviceType.${server.serviceType}`);
  const serverNameMatch = serverEntryMatchesSearch(searchQuery, server, serviceTypeLabel);

  const categories = useMemo(() => {
    const all = SERVER_TREE_CATEGORIES.map((category) => ({
      category,
      label: t(`server.tabs.${category}`),
      iconKind: category,
    }));
    if (!hasSidebarTreeSearch(searchQuery) || serverNameMatch) {
      return all;
    }
    return all.filter((item) => sidebarTreeSearchMatches(searchQuery, item.label));
  }, [searchQuery, serverNameMatch, t]);

  const visible =
    !hasSidebarTreeSearch(searchQuery) || serverNameMatch || categories.length > 0;

  useEffect(() => {
    if (!hasSidebarTreeSearch(searchQuery)) {
      return;
    }
    ensureExpanded(makeServerTreeKey(server.id));
  }, [ensureExpanded, searchQuery, server.id]);

  if (!serverExpanded) return null;

  if (!serverSupportsResources(server)) {
    return (
      <SidebarTreeEmpty style={{ paddingLeft: 28 }}>
        {t("server.sidebar.treeUnsupported")}
      </SidebarTreeEmpty>
    );
  }

  if (!visible) {
    return null;
  }

  return (
    <div className="server-tree-children">
      {categories.map((item) => {
        const itemKey = makeServerTreeKey(server.id, item.category);
        const openCategory = () => {
          ensureExpanded(makeServerTreeKey(server.id));
          onNavigate(
            {
              serverId: server.id,
              detailTab: item.category,
            },
            "permanent",
          );
        };
        return (
          <SidebarTreeNode
            key={item.category}
            depth={1}
            module="server"
            nodeType={item.category}
            treeKey={itemKey}
            label={item.label}
            icon={<ServerTreeIcon kind={item.iconKind} />}
            className={serverTreeNodeClassName(item.iconKind)}
            hasChildren={false}
            expanded={false}
            active={activeNavKey === itemKey}
            onToggle={() => {}}
            onActivate={openCategory}
          />
        );
      })}
    </div>
  );
}

export interface ServerPanelTreeSidebarProps {
  servers: ServerEntry[];
  activeServerId: string | null;
  activeNavKey: string | null;
  searchQuery?: string;
  onNavigate: ServerSidebarNavigate;
  onCreateServer?: () => void;
  onEditServer?: (server: ServerEntry) => void;
  onDeleteServer?: (serverIds: string | string[]) => void;
  section?: VerticalSplitSidebarSectionConfig;
}

export function ServerPanelTreeSidebar({
  servers,
  activeServerId,
  activeNavKey,
  searchQuery = "",
  onNavigate,
  onCreateServer,
  onEditServer,
  onDeleteServer,
  section,
}: ServerPanelTreeSidebarProps) {
  const { t } = useI18n();
  const refreshConnections = useConnectionStore((s) => s.refresh);
  const connectionsLoading = useConnectionStore((s) => s.loading);
  const syncPanelServersFromConnections = useServerPanelCacheStore(
    (s) => s.syncPanelServersFromConnections,
  );
  const refreshAllResources = useServerPanelCacheStore((s) => s.refreshAllResources);
  const cacheRefreshing = useServerPanelCacheStore((s) => s.refreshing);
  const { isExpanded, toggle, ensureExpanded } = usePersistedServerTreeExpanded();
  const [ctxPos, setCtxPos] = useState<{ x: number; y: number } | null>(null);
  const [ctxServer, setCtxServer] = useState<ServerEntry | null>(null);
  const selectedIdsRef = useRef<ReadonlySet<string>>(new Set());
  const handleSelectedIdsChange = useCallback((ids: ReadonlySet<string>) => {
    selectedIdsRef.current = ids;
  }, []);

  const handleRefreshPanels = useCallback(() => {
    void (async () => {
      await refreshConnections();
      const connections = useConnectionStore.getState().connections;
      syncPanelServersFromConnections(connections);
      const panelServers = useServerPanelCacheStore.getState().panelServers;
      await refreshAllResources(panelServers);
    })();
  }, [refreshAllResources, refreshConnections, syncPanelServersFromConnections]);

  useEffect(() => {
    if (!activeServerId) return;
    ensureExpanded(makeServerTreeKey(activeServerId));
  }, [activeServerId, ensureExpanded]);

  const sortedServers = useMemo(
    () => [...servers].sort((a, b) => a.name.localeCompare(b.name)),
    [servers],
  );

  useEffect(() => {
    if (!hasSidebarTreeSearch(searchQuery)) {
      return;
    }
    for (const server of sortedServers) {
      ensureExpanded(makeServerTreeKey(server.id));
    }
  }, [ensureExpanded, searchQuery, sortedServers]);

  const handleContextMenu = (event: MouseEvent, server: ServerEntry) => {
    event.preventDefault();
    setCtxPos({ x: event.clientX, y: event.clientY });
    setCtxServer(server);
  };

  const serverKeyById = useMemo(() => {
    const map = new Map<string, string>();
    for (const server of servers) {
      map.set(makeServerTreeKey(server.id), server.id);
    }
    return map;
  }, [servers]);

  const ctxItems: ContextMenuItem[] = [
    {
      id: "edit",
      label: t("server.sidebar.edit"),
      onClick: () => ctxServer && onEditServer?.(ctxServer),
    },
    {
      id: "delete",
      label: t("server.sidebar.delete"),
      danger: true,
      onClick: () => {
        if (!ctxServer || !onDeleteServer) return;
        const clickedKey = makeServerTreeKey(ctxServer.id);
        const keys = resolveSidebarTreeDeleteTargets(clickedKey, selectedIdsRef.current, {
          filter: (id) => serverKeyById.has(id),
        });
        const ids = keys
          .map((key) => serverKeyById.get(key))
          .filter((id): id is string => Boolean(id));
        if (ids.length === 0) return;
        onDeleteServer(ids.length === 1 ? ids[0]! : ids);
      },
    },
  ];

  const refreshPanelsButton = (
    <Button
      type="button"
      variant="icon"
      size="icon-xs"
      className="server-sidebar-refresh"
      title={t("server.sidebar.refreshPanels")}
      aria-label={t("server.sidebar.refreshPanels")}
      disabled={connectionsLoading || cacheRefreshing}
      onClick={handleRefreshPanels}
    >
      <IconRefresh size={14} />
    </Button>
  );

  const addServerButton = (
    <div className="schema-toolbar schema-toolbar--inline">
      <Button
        type="button"
        variant="icon"
        className="server-sidebar-add"
        title={t("server.sidebar.addPanel")}
        onClick={onCreateServer}
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
      <SidebarTreeRoot className="server-sidebar-body">
        {sortedServers.length === 0 ? (
          <div className="empty-state compact">{t("common.noResources")}</div>
        ) : (
          sortedServers.map((server) => {
            const serverKey = makeServerTreeKey(server.id);
            const serverExpanded = isExpanded(serverKey);
            return (
              <div key={server.id} className="server-tree-server">
                <SidebarTreeNode
                  depth={0}
                  module="server"
                  nodeType="server"
                  treeKey={serverKey}
                  icon={<ServerTreeIcon kind="server" />}
                  className={serverTreeNodeClassName(
                    "server",
                    server.serviceType === "bt"
                      ? "server-tree-node--bt"
                      : "server-tree-node--onepanel",
                  )}
                  label={
                    <span className="server-tree-server-label">
                      <span className="server-tree-server-name">{server.name}</span>
                      <span
                        className={`badge badge-muted server-item__type-tag server-item__type-tag--${server.serviceType === "bt" ? "bt" : "onepanel"}`}
                      >
                        {t(`server.serviceType.${server.serviceType}`)}
                      </span>
                    </span>
                  }
                  hasChildren
                  expanded={serverExpanded}
                  active={activeNavKey === serverKey || activeServerId === server.id}
                  onToggle={() => toggle(serverKey)}
                  onActivate={() => onNavigate({ serverId: server.id }, "permanent")}
                  onContextMenu={(event) => handleContextMenu(event, server)}
                />
                <ServerTreeBranch
                  server={server}
                  serverExpanded={serverExpanded}
                  activeNavKey={activeNavKey}
                  searchQuery={searchQuery}
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
      <div className="server-sidebar">
        <VerticalSplitSidebarSection
          {...section}
          actions={
            <>
              <span className="badge badge-muted">{servers.length}</span>
              {refreshPanelsButton}
              {addServerButton}
            </>
          }
        >
          {panelBody}
        </VerticalSplitSidebarSection>
      </div>
    );
  }

  return (
    <div className="server-sidebar">
      <div className="server-sidebar-subheader window-drag-surface" data-tauri-drag-region>
        <span>{t("server.sidebar.title")}</span>
        <span className="badge badge-muted">{servers.length}</span>
        {refreshPanelsButton}
        {addServerButton}
      </div>
      {panelBody}
    </div>
  );
}
