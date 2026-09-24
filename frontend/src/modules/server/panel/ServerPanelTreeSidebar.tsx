import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { useI18n } from "@/i18n";
import { ContextMenu, type ContextMenuItem } from "@/components/ui/menu";
import { contextMenuIcons } from "@/components/ui/menu/contextMenuIcons";
import { WorkbenchActionButton } from "@/components/ui/primitives/WorkbenchActionButton";
import { StatusDot, type StatusDotStatus } from "@/components/ui/primitives/StatusDot";
import { appConfirm } from "@/lib/appConfirm";
import { showToast } from "@/stores/toastStore";
import {
  type VerticalSplitSidebarSectionConfig,
} from "@/components/ui/sidebar/VerticalSplitSidebar";
import { ModuleSidebarSection, SidebarCountBadge } from "@/components/ui/module-sidebar";
import {
  ModuleSidebarTreeToolbar,
  usePersistedTreeExpanded,
} from "@/components/ui/module-sidebar";
import {
  SidebarTreeEmpty,
  SidebarTreeNode,
  SidebarTreeRoot,
  SidebarTreeSelectionProvider,
  resolveSidebarTreeDeleteTargets,
} from "@/components/ui/sidebar-tree";
import { useConnectionStore } from "@/stores/connectionStore";
import { useServerPanelCacheStore } from "@/stores/serverPanelCacheStore";
import { isDiscoverySkip, runDiscoveryProbe, sshDiscoveryScope, type DiscoveryCandidates } from "@/lib/discoveryBus";
import { DiscoveryImportDialog, type DiscoveryPreviewRow } from "@/components/ui/DiscoveryImportDialog";
import { importPanelPreviewRows } from "./syncPanelsFromSsh";
import type { ServerEntry } from "./serverConnection";
import {
  isBtPanelService,
  isHestiaPanelService,
  isOnePanelService,
  panelHasCapability,
  panelServiceTypeLabel,
  panelTypeTagModifier,
} from "./panelPlugin";
import { listPanelSidebarTabs } from "./panelTabIds";
import { usePluginRuntimeStore } from "../../../stores/pluginRuntimeStore";
import {
  makeServerTreeKey,
  serverSupportsResources,
} from "./serverResourceLabels";
import type { ServerSidebarNavigate } from "./serverSidebarNav";
import { hasSidebarTreeSearch, sidebarTreeSearchMatches } from "@/lib/sidebarTreeSearch";
import {
  buildSidebarNoteMenuItem,
  SidebarNoteKeys,
} from "@/lib/sidebarNotes";
import { useSidebarNoteStore } from "@/stores/sidebarNoteStore";
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

function ServerTreeBranch({
  server,
  serverExpanded,
  activeNavKey,
  searchQuery,
  ensureExpanded,
  onNavigate,
}: ServerTreeBranchProps) {
  const { t } = useI18n();
  const pluginItems = usePluginRuntimeStore((s) => s.items);
  const serviceTypeLabel = panelServiceTypeLabel(server.serviceType, t);
  const serverNameMatch = serverEntryMatchesSearch(searchQuery, server, serviceTypeLabel);

  const categories = useMemo(() => {
    const all = listPanelSidebarTabs(server.serviceType).map((category) => ({
      category,
      label: t(`server.tabs.${category}`),
      iconKind: category,
    }));
    if (!hasSidebarTreeSearch(searchQuery) || serverNameMatch) {
      return all;
    }
    return all.filter((item) => sidebarTreeSearchMatches(searchQuery, item.label));
  }, [pluginItems, searchQuery, server.serviceType, serverNameMatch, t]);

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
  const connectionsLoading = useConnectionStore((s) => s.loading);
  const syncPanelServersFromConnections = useServerPanelCacheStore(
    (s) => s.syncPanelServersFromConnections,
  );
  const refreshAllResources = useServerPanelCacheStore((s) => s.refreshAllResources);
  const refreshServer = useServerPanelCacheStore((s) => s.refreshServer);
  const refreshServerApps = useServerPanelCacheStore((s) => s.refreshServerApps);
  const cacheRefreshing = useServerPanelCacheStore((s) => s.refreshing);
  const resourcesByServerId = useServerPanelCacheStore((s) => s.resourcesByServerId);
  const refreshingServerIds = useServerPanelCacheStore((s) => s.refreshingServerIds);
  const refreshingAppsServerIds = useServerPanelCacheStore((s) => s.refreshingAppsServerIds);
  // storageKey 沿用旧 key，用户现有展开态不断。
  const { isExpanded, toggle, ensureExpanded, setAllExpanded } = usePersistedTreeExpanded(
    "omnipanel-server-tree-expanded.v1",
  );
  const [ctxPos, setCtxPos] = useState<{ x: number; y: number } | null>(null);
  const [ctxServer, setCtxServer] = useState<ServerEntry | null>(null);
  const [syncingFromSsh, setSyncingFromSsh] = useState(false);
  const [discoveryRows, setDiscoveryRows] = useState<DiscoveryPreviewRow[]>([]);
  const [discoveryOpen, setDiscoveryOpen] = useState(false);
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
        if (
          isOnePanelService(server.serviceType) ||
          isBtPanelService(server.serviceType) ||
          panelHasCapability(server.serviceType, "apps")
        ) {
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
        const { scope, skippedProdCount, prodHostIds } = sshDiscoveryScope(connections);
        let hostIds = [...(scope.hostIds ?? [])];
        if (skippedProdCount > 0) {
          const scanProd = await appConfirm(
            t("server.sidebar.syncFromSshProdConfirm", { count: String(skippedProdCount) }),
            t("server.sidebar.syncFromSshProdTitle"),
            { confirmLabel: t("server.sidebar.syncFromSshProdConfirmBtn"), kind: "warning" },
          );
          if (scanProd) hostIds = [...hostIds, ...prodHostIds];
          else showToast(t("server.sidebar.syncFromSshProdHostsSkipped", { count: String(skippedProdCount) }));
        }
        if (hostIds.length === 0) {
          showToast(t("server.sidebar.syncFromSshNoSsh"));
          return;
        }
        const result = await runDiscoveryProbe("ssh-panel", { hostIds, envTag: null });
        if (isDiscoverySkip(result)) {
          showToast(t("server.sidebar.syncFromSshProdSkipped"));
          return;
        }
        const probed = result as DiscoveryCandidates;
        if (probed.errors?.length) {
          showToast(probed.errors.slice(0, 2).join("；"));
        }
        if (!probed.rows?.length) {
          showToast(t("plugins.discovery.empty"));
          return;
        }
        setDiscoveryRows(probed.rows);
        setDiscoveryOpen(true);
      } catch (err) {
        showToast(String(err));
      } finally {
        setSyncingFromSsh(false);
      }
    })();
  }, [refreshConnections, t]);

  const handleImportDiscovery = useCallback(
    (selected: DiscoveryPreviewRow[]) => {
      void (async () => {
        setSyncingFromSsh(true);
        try {
          const syncResult = await importPanelPreviewRows(selected);
          await refreshConnections();
          syncPanelServersFromConnections(useConnectionStore.getState().connections);
          setDiscoveryOpen(false);
          showToast(
            t("server.sidebar.syncFromSshDone", {
              added: syncResult.added,
              updated: syncResult.updated,
              skipped: syncResult.skipped,
              failed: syncResult.failed,
            }),
          );
          if (syncResult.errors.length > 0) {
            showToast(syncResult.errors.slice(0, 3).join("；"));
          }
        } catch (err) {
          showToast(String(err));
        } finally {
          setSyncingFromSsh(false);
        }
      })();
    },
    [refreshConnections, syncPanelServersFromConnections, t],
  );

  useEffect(() => {
    if (!activeServerId) return;
    ensureExpanded(makeServerTreeKey(activeServerId));
  }, [activeServerId, ensureExpanded]);

  const sortedServers = useMemo(
    () => [...servers].sort((a, b) => a.name.localeCompare(b.name)),
    [servers],
  );

  /** Shift 范围选顺序：服务 + 其下面板分类，按渲染顺序扁平。 */
  const orderedKeys = useMemo(
    () =>
      sortedServers.flatMap((server) => [
        makeServerTreeKey(server.id),
        ...listPanelSidebarTabs(server.serviceType).map((category) =>
          makeServerTreeKey(server.id, category),
        ),
      ]),
    [sortedServers],
  );
  const serverKeys = useMemo(
    () => sortedServers.map((server) => makeServerTreeKey(server.id)),
    [sortedServers],
  );
  const expandAllServersDisabled = useMemo(
    () => serverKeys.length === 0 || serverKeys.every((key) => isExpanded(key)),
    [serverKeys, isExpanded],
  );
  const collapseAllServersDisabled = useMemo(
    () => serverKeys.length === 0 || serverKeys.every((key) => !isExpanded(key)),
    [serverKeys, isExpanded],
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

  const sidebarNotes = useSidebarNoteStore((s) => s.notes);

  const ctxItems: ContextMenuItem[] = [
    {
      id: "edit",
      label: t("server.sidebar.edit"),
      icon: contextMenuIcons.edit,
      onClick: () => ctxServer && onEditServer?.(ctxServer),
    },
    ...(ctxServer
      ? [buildSidebarNoteMenuItem(SidebarNoteKeys.server(ctxServer.id), t)]
      : []),
    {
      id: "delete",
      label: t("server.sidebar.delete"),
      icon: contextMenuIcons.delete,
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
      <WorkbenchActionButton
        icon
        title={t("server.sidebar.addPanel")}
        aria-label={t("server.sidebar.addPanel")}
        onClick={onCreateServer}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </WorkbenchActionButton>
      <WorkbenchActionButton
        icon
        title={
          syncingFromSsh
            ? t("server.sidebar.syncFromSshRunning")
            : t("server.sidebar.syncFromSsh")
        }
        aria-label={t("server.sidebar.syncFromSsh")}
        disabled={connectionsLoading || syncingFromSsh}
        onClick={handleSyncFromSsh}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 3v12" />
          <path d="m8 11 4 4 4-4" />
          <path d="M4 19h16" />
        </svg>
      </WorkbenchActionButton>
    </div>
  );

  const panelBody = (
    <>
      <SidebarTreeSelectionProvider
        orderedKeys={orderedKeys}
        onSelectedIdsChange={handleSelectedIdsChange}
      >
      <SidebarTreeRoot className="server-sidebar-body">
        {sortedServers.length === 0 ? (
            <SidebarTreeEmpty>{t("common.noResources")}</SidebarTreeEmpty>
        ) : (
            sortedServers.map((server) => {
            const serverKey = makeServerTreeKey(server.id);
            const serverExpanded = isExpanded(serverKey);
            const iconKind = serverTreeIconKindForPanel(server.serviceType);
            const supportsResources = serverSupportsResources(server);
            const serverRefreshing =
              Boolean(refreshingServerIds[server.id]) || Boolean(refreshingAppsServerIds[server.id]);
            const resources = resourcesByServerId[server.id];
            const serverStatus: StatusDotStatus = serverRefreshing
              ? "connecting"
              : resources?.error
                ? "offline"
                : resources?.refreshedAt
                  ? "online"
                  : "idle";
            const serverStatusTitle = serverRefreshing
              ? t("common.statusConnecting")
              : resources?.error
                ? `${t("common.statusOffline")}：${resources.error}`
                : serverStatus === "online"
                  ? t("common.statusOnline")
                  : t("common.statusIdle");
            return (
              <div key={server.id} className="server-tree-server">
                <SidebarTreeNode
                  depth={0}
                  module="server"
                  nodeType="server"
                  treeKey={serverKey}
                  icon={<ServerTreeIcon kind={iconKind} />}
                  prefix={<StatusDot status={serverStatus} title={serverStatusTitle} />}
                  className={serverTreeNodeClassName(
                    iconKind,
                    isBtPanelService(server.serviceType)
                      ? "server-tree-node--bt"
                      : isOnePanelService(server.serviceType)
                        ? "server-tree-node--onepanel"
                        : isHestiaPanelService(server.serviceType)
                          ? "server-tree-node--hestia"
                          : undefined,
                  )}
                  label={
                    <span className="server-tree-server-label">
                      <span className="server-tree-server-name">{server.name}</span>
                      <span
                        className={`sidebar-tag-chip badge badge-muted server-item__type-tag server-item__type-tag--${panelTypeTagModifier(server.serviceType)}`}
                      >
                        {panelServiceTypeLabel(server.serviceType, t)}
                      </span>
                    </span>
                  }
                  note={sidebarNotes[SidebarNoteKeys.server(server.id)]}
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
      <DiscoveryImportDialog
        open={discoveryOpen}
        title={t("plugins.discovery.panelTitle")}
        hint={t("plugins.discovery.panelHint")}
        rows={discoveryRows}
        busy={syncingFromSsh}
        onClose={() => setDiscoveryOpen(false)}
        onImport={handleImportDiscovery}
      />
    </>
  );

  if (section) {
    return (
      <div className="server-sidebar">
        <ModuleSidebarSection
          {...section}
          count={servers.length}
          actions={toolbarActions}
          toolbar={
            <ModuleSidebarTreeToolbar
              onRefresh={() => void handleRefreshPanels()}
              onExpandAll={() => setAllExpanded(serverKeys, true)}
              onCollapseAll={() => setAllExpanded(serverKeys, false)}
              refreshing={cacheRefreshing}
              refreshDisabled={connectionsLoading || cacheRefreshing || syncingFromSsh}
              expandDisabled={expandAllServersDisabled}
              collapseDisabled={collapseAllServersDisabled}
            />
          }
        >
          {panelBody}
        </ModuleSidebarSection>
      </div>
    );
  }

  return (
    <div className="server-sidebar">
      <div className="server-sidebar-subheader window-drag-surface" data-tauri-drag-region>
        <span>{t("server.sidebar.title")}</span>
        <SidebarCountBadge count={servers.length} />
        {toolbarActions}
      </div>
      {panelBody}
    </div>
  );
}
