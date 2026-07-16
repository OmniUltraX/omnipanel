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
import type { ServerEntry } from "./serverConnection";
import type { ServerPanelDockOpenMode } from "./serverPanelWorkspaceTabs";
import { getAppDisplayName } from "./appCard";
import { useInstalledApps } from "./useInstalledApps";
import { useServerWebsites } from "./useServerWebsites";
import { useServerCertificates } from "./useServerCertificates";
import { usePersistedServerTreeExpanded } from "./usePersistedServerTreeExpanded";
import {
  certificateRowId,
  certificateRowLabel,
  makeServerTreeKey,
  serverSupportsResources,
  websiteRowId,
  websiteRowLabel,
} from "./serverResourceLabels";
import type { ServerSidebarNavigate } from "./serverSidebarNav";
import type { ServerDetailTab } from "./ServerWorkspace";
import { hasSidebarTreeSearch, sidebarTreeSearchMatches } from "@/lib/sidebarTreeSearch";
import {
  serverEntryMatchesSearch,
} from "../serverTreeSearch";
import {
  ServerTreeIcon,
  serverCategoryIconKind,
  serverItemIconKind,
  serverTreeNodeClassName,
} from "./serverTreeIcons";

type ServerTreeBranchProps = {
  server: ServerEntry;
  serverExpanded: boolean;
  activeNavKey: string | null;
  searchQuery: string;
  isExpanded: (key: string) => boolean;
  toggle: (key: string) => void;
  ensureExpanded: (key: string) => void;
  onNavigate: ServerSidebarNavigate;
};

function ServerTreeBranch({
  server,
  serverExpanded,
  activeNavKey,
  searchQuery,
  isExpanded,
  toggle,
  ensureExpanded,
  onNavigate,
}: ServerTreeBranchProps) {
  const { t } = useI18n();
  const serviceTypeLabel = t(`server.serviceType.${server.serviceType}`);
  const serverNameMatch = serverEntryMatchesSearch(searchQuery, server, serviceTypeLabel);
  const loadServer = serverExpanded && serverSupportsResources(server) ? server : null;
  const { apps, loading: appsLoading } = useInstalledApps(loadServer);
  const { items: websites, loading: websitesLoading } = useServerWebsites(loadServer);
  const { items: certificates, loading: certificatesLoading } = useServerCertificates(loadServer);

  const categories = useMemo(() => {
    const filterItems = (
      categoryLabel: string,
      items: Array<{ id: string; label: string }>,
    ) => {
      if (!hasSidebarTreeSearch(searchQuery) || serverNameMatch) {
        return items;
      }
      if (sidebarTreeSearchMatches(searchQuery, categoryLabel)) {
        return items;
      }
      return items.filter((item) => sidebarTreeSearchMatches(searchQuery, item.label));
    };

    const raw = [
      {
        id: "apps" as const,
        label: t("server.tabs.apps"),
        loading: appsLoading,
        items: apps.map((app) => ({ id: app.uid, label: getAppDisplayName(app) })),
      },
      {
        id: "websites" as const,
        label: t("server.tabs.websites"),
        loading: websitesLoading,
        items: websites.map((row, index) => ({
          id: websiteRowId(row, index),
          label: websiteRowLabel(row),
        })),
      },
      {
        id: "certificates" as const,
        label: t("server.tabs.certificates"),
        loading: certificatesLoading,
        items: certificates.map((row, index) => ({
          id: certificateRowId(row, index),
          label: certificateRowLabel(row),
        })),
      },
    ];

    return raw
      .map((category) => {
        const items = filterItems(category.label, category.items);
        return {
          ...category,
          count: items.length,
          items,
        };
      })
      .filter((category) => {
        if (!hasSidebarTreeSearch(searchQuery) || serverNameMatch) {
          return true;
        }
        if (sidebarTreeSearchMatches(searchQuery, category.label)) {
          return true;
        }
        return category.items.length > 0;
      });
  }, [
    apps,
    appsLoading,
    certificates,
    certificatesLoading,
    searchQuery,
    serverNameMatch,
    t,
    websites,
    websitesLoading,
  ]);

  useEffect(() => {
    if (!hasSidebarTreeSearch(searchQuery)) {
      return;
    }
    ensureExpanded(makeServerTreeKey(server.id));
    for (const category of categories) {
      ensureExpanded(makeServerTreeKey(server.id, category.id));
    }
  }, [categories, ensureExpanded, searchQuery, server.id]);

  if (!serverExpanded) return null;

  if (!serverSupportsResources(server)) {
    return (
      <SidebarTreeEmpty style={{ paddingLeft: 28 }}>
        {t("server.sidebar.treeUnsupported")}
      </SidebarTreeEmpty>
    );
  }

  if (hasSidebarTreeSearch(searchQuery) && !serverNameMatch && categories.length === 0) {
    return null;
  }

  return (
    <>
      {categories.map((category) => {
        const categoryKey = makeServerTreeKey(server.id, category.id);
        const categoryExpanded = isExpanded(categoryKey);
        const openCategory = (mode?: ServerPanelDockOpenMode) => {
          ensureExpanded(makeServerTreeKey(server.id));
          ensureExpanded(categoryKey);
          onNavigate({ serverId: server.id, detailTab: category.id }, mode);
        };

        return (
          <div key={category.id} className="server-tree-category">
            <SidebarTreeNode
              depth={1}
              module="server"
              nodeType={category.id}
              treeKey={categoryKey}
              label={category.label}
              icon={<ServerTreeIcon kind={serverCategoryIconKind(category.id)} />}
              className={serverTreeNodeClassName(serverCategoryIconKind(category.id))}
              hasChildren
              expanded={categoryExpanded}
              active={activeNavKey === categoryKey}
              onToggle={() => toggle(categoryKey)}
              onActivate={() => openCategory("permanent")}
              trailing={
                category.loading ? (
                  <span className="server-tree-badge">…</span>
                ) : (
                  <span className="server-tree-badge">{category.count}</span>
                )
              }
            />
            {categoryExpanded ? (
              <div className="server-tree-children">
                {category.loading && category.items.length === 0 ? (
                  <SidebarTreeEmpty>{t("server.sidebar.treeLoading")}</SidebarTreeEmpty>
                ) : category.items.length === 0 ? (
                  <SidebarTreeEmpty>{t("server.sidebar.treeEmpty")}</SidebarTreeEmpty>
                ) : (
                  category.items.map((item) => {
                    const itemKey = makeServerTreeKey(server.id, category.id, item.id);
                    const openItem = (mode?: ServerPanelDockOpenMode) => {
                      ensureExpanded(makeServerTreeKey(server.id));
                      ensureExpanded(categoryKey);
                      onNavigate(
                        {
                          serverId: server.id,
                          detailTab: category.id as ServerDetailTab,
                          itemId: item.id,
                        },
                        mode,
                      );
                    };
                    return (
                      <SidebarTreeNode
                        key={item.id}
                        depth={2}
                        module="server"
                        nodeType={category.id}
                        treeKey={itemKey}
                        label={item.label}
                        icon={<ServerTreeIcon kind={serverItemIconKind(category.id)} />}
                        className={serverTreeNodeClassName(serverItemIconKind(category.id))}
                        hasChildren={false}
                        expanded={false}
                        active={activeNavKey === itemKey}
                        onToggle={() => {}}
                        onActivate={() => openItem("permanent")}
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
  const { isExpanded, toggle, ensureExpanded } = usePersistedServerTreeExpanded();
  const [ctxPos, setCtxPos] = useState<{ x: number; y: number } | null>(null);
  const [ctxServer, setCtxServer] = useState<ServerEntry | null>(null);
  const selectedIdsRef = useRef<ReadonlySet<string>>(new Set());
  const handleSelectedIdsChange = useCallback((ids: ReadonlySet<string>) => {
    selectedIdsRef.current = ids;
  }, []);

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
      <div className="server-sidebar">
        <VerticalSplitSidebarSection
          {...section}
          actions={
            <>
              <span className="badge badge-muted">{servers.length}</span>
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
        {addServerButton}
      </div>
      {panelBody}
    </div>
  );
}
