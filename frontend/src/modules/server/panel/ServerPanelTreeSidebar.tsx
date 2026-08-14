import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { useI18n } from "@/i18n";
import { ContextMenu, type ContextMenuItem } from "@/components/ui/ContextMenu";
import { Button } from "@/components/ui/Button";
import { IconRefresh } from "@/components/ui/Icons";
import { appConfirm } from "@/lib/appConfirm";
import { showToast } from "@/stores/toastStore";
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
import { syncPanelsFromSshConnections } from "./syncPanelsFromSsh";
import { usePersistedServerTreeExpanded } from "./usePersistedServerTreeExpanded";
import {
  makeServerTreeKey,
  serverSupportsResources,
} from "./serverResourceLabels";
import type { ServerSidebarNavigate } from "./serverSidebarNav";
import { hasSidebarTreeSearch, sidebarTreeSearchMatches } from "@/lib/sidebarTreeSearch";
import { serverEntryMatchesSearch } from "../serverTreeSearch";
import { ServerTreeIcon, serverTreeIconKindForPanel, serverTreeNodeClassName } from "./serverTreeIcons";

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
        const openCategory = (mode: "preview" | "permanent") => {
          ensureExpanded(makeServerTreeKey(server.id));
          onNavigate(
            {
              serverId: server.id,
              detailTab: item.category,
            },
            mode,
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
            onSelect={() => openCategory("preview")}
            onActivate={() => openCategory("permanent")}
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
  const saveConn = useConnectionStore((s) => s.save);
  const connectionsLoading = useConnectionStore((s) => s.loading);
  const syncPanelServersFromConnections = useServerPanelCacheStore(
    (s) => s.syncPanelServersFromConnections,
  );
  const refreshAllResources = useServerPanelCacheStore((s) => s.refreshAllResources);
  const refreshServer = useServerPanelCacheStore((s) => s.refreshServer);
  const refreshServerApps = useServerPanelCacheStore((s) => s.refreshServerApps);
  const isServerRefreshing = useServerPanelCacheStore((s) => s.isServerRefreshing);
  const isServerAppsRefreshing = useServerPanelCacheStore((s) => s.isServerAppsRefreshing);
  const cacheRefreshing = useServerPanelCacheStore((s) => s.refreshing);
  const { isExpanded, toggle, ensureExpanded } = usePersistedServerTreeExpanded();
  const [ctxPos, setCtxPos] = useState<{ x: number; y: number } | null>(null);
  const [ctxServer, setCtxServer] = useState<ServerEntry | null>(null);
  const [syncingFromSsh, setSyncingFromSsh] = useState(false);
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

  const handleRefreshServer = useCallback(
    (server: ServerEntry) => {
      void (async () => {
        await refreshServer(server);
        if (server.serviceType === "1panel" || server.serviceType === "bt") {
          await refreshServerApps(server);
        }
      })();
    },
    [refreshServer, refreshServerApps],
  );

  const handleSyncFromSsh = useCallback(() => {
    void (async () => {
      const ok = await appConfirm(
        t("server.sidebar.syncFromSshMsg"),
        t("server.sidebar.syncFromSshTitle"),
        {
          confirmLabel: t("server.sidebar.syncFromSshConfirm"),
          kind: "warning",
        },
      );
      if (!ok) return;

      setSyncingFromSsh(true);
      try {
        await refreshConnections();
        const connections = useConnectionStore.getState().connections;
        const sshCount = connections.filter((c) => c.kind === "ssh").length;
        if (sshCount === 0) {
          showToast(t("server.sidebar.syncFromSshNoSsh"));
          return;
        }

        showToast(t("server.sidebar.syncFromSshStarted"));
        const result = await syncPanelsFromSshConnections({
          connections,
          saveConn,
        });

        await refreshConnections();
        const next = useConnectionStore.getState().connections;
        syncPanelServersFromConnections(next);

        showToast(
          t("server.sidebar.syncFromSshDone", {
            added: result.added,
            updated: result.updated,
            skipped: result.skipped,
            failed: result.failed,
          }),
        );
        if (result.errors.length > 0) {
          const preview = result.errors.slice(0, 3).join("；");
          showToast(
            result.errors.length > 3
              ? `${preview}… (+${result.errors.length - 3})`
              : preview,
          );
        }
      } catch (err) {
        showToast(String(err));
      } finally {
        setSyncingFromSsh(false);
      }
    })();
  }, [refreshConnections, saveConn, syncPanelServersFromConnections, t]);

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

  const toolbarActions = (
    <div className="schema-toolbar schema-toolbar--inline">
      <Button
        type="button"
        variant="icon"
        size="icon-xs"
        className="server-sidebar-refresh"
        title={
          syncingFromSsh
            ? t("server.sidebar.syncFromSshRunning")
            : t("server.sidebar.syncFromSsh")
        }
        aria-label={t("server.sidebar.syncFromSsh")}
        disabled={connectionsLoading || syncingFromSsh}
        onClick={handleSyncFromSsh}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 3v12" />
          <path d="m8 11 4 4 4-4" />
          <path d="M4 19h16" />
        </svg>
      </Button>
      <Button
        type="button"
        variant="icon"
        size="icon-xs"
        className="server-sidebar-refresh"
        title={t("server.sidebar.refreshPanels")}
        aria-label={t("server.sidebar.refreshPanels")}
        disabled={connectionsLoading || cacheRefreshing || syncingFromSsh}
        onClick={handleRefreshPanels}
      >
        <IconRefresh size={14} />
      </Button>
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
            const iconKind = serverTreeIconKindForPanel(server.serviceType);
            const supportsResources = serverSupportsResources(server);
            const serverRefreshing =
              isServerRefreshing(server.id) || isServerAppsRefreshing(server.id);
            return (
              <div key={server.id} className="server-tree-server">
                <SidebarTreeNode
                  depth={0}
                  module="server"
                  nodeType="server"
                  treeKey={serverKey}
                  icon={<ServerTreeIcon kind={iconKind} />}
                  className={serverTreeNodeClassName(
                    iconKind,
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
                  onSelect={() => onNavigate({ serverId: server.id }, "preview")}
                  onActivate={() => onNavigate({ serverId: server.id }, "permanent")}
                  onContextMenu={(event) => handleContextMenu(event, server)}
                  onRefresh={
                    supportsResources ? () => handleRefreshServer(server) : undefined
                  }
                  refreshing={serverRefreshing}
                  refreshDisabled={connectionsLoading || cacheRefreshing || syncingFromSsh}
                  refreshTitle={t("server.sidebar.refreshPanel")}
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
              {toolbarActions}
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
        {toolbarActions}
      </div>
      {panelBody}
    </div>
  );
}
