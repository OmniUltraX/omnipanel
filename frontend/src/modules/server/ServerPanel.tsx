import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { ModuleSegmentDock } from "../../components/dock";
import { ModuleWorkspaceLayout } from "../../components/workspace";
import { WorkspaceEmptyPage } from "../../components/ui/workspace/WorkspaceEmptyPage";
import { useModuleSuspended } from "../../lib/moduleVisibility";
import { useConnectionStore } from "../../stores/connectionStore";
import { useI18n } from "../../i18n";
import { appConfirm } from "../../lib/appConfirm";
import { ServerConnectionDialog } from "./panel/ServerConnectionDialog";
import { ServerPanelSidebar } from "./panel/ServerPanelSidebar";
import { ServerSidebarLinkageProvider } from "./panel/ServerSidebarLinkageContext";
import { ServerDockPanel } from "./panel/ServerDockPanel";
import type { ServerPanelDockOpenMode } from "./panel/serverPanelWorkspaceTabs";
import { makeServerTreeKey } from "./panel/serverResourceLabels";
import type { ServerSidebarNavTarget } from "./panel/serverSidebarNav";
import { connectionToServerEntry } from "./panel/panelConnection";
import type { ServerEntry } from "./panel/serverConnection";
import type { Connection } from "../../ipc/bindings";
import {
  useActiveServerPanelId,
  useServerPanelDockStore,
} from "../../stores/serverPanelDockStore";

export function ServerPanel() {
  const { t } = useI18n();
  const location = useLocation();
  const isActiveRoute = location.pathname === "/module/server";
  const moduleSuspended = useModuleSuspended();
  const moduleLive = isActiveRoute && !moduleSuspended;
  const connections = useConnectionStore((s) => s.connections);
  const removeConn = useConnectionStore((s) => s.remove);

  const panelServers = useMemo(
    () => connections.filter((c) => c.kind === "panel").map(connectionToServerEntry),
    [connections],
  );

  const dockTabs = useServerPanelDockStore((s) => s.tabs);
  const activeTabId = useServerPanelDockStore((s) => s.activeTabId);
  const dockLayout = useServerPanelDockStore((s) => s.dockLayout);
  const selectServer = useServerPanelDockStore((s) => s.selectServer);
  const closeTab = useServerPanelDockStore((s) => s.closeTab);
  const setActiveTabId = useServerPanelDockStore((s) => s.setActiveTabId);
  const setDockLayout = useServerPanelDockStore((s) => s.setDockLayout);
  const removeServerTabs = useServerPanelDockStore((s) => s.removeServerTabs);

  const activeServerId = useActiveServerPanelId();

  const [showDialog, setShowDialog] = useState(false);
  const [editPanelConnection, setEditPanelConnection] = useState<Connection | undefined>();
  const [activeNavKey, setActiveNavKey] = useState<string | null>(null);
  const [navTarget, setNavTarget] = useState<ServerSidebarNavTarget | null>(null);

  const serverById = useMemo(() => {
    const map = new Map<string, ServerEntry>();
    for (const server of panelServers) {
      map.set(server.id, server);
    }
    return map;
  }, [panelServers]);

  useEffect(() => {
    const validIds = new Set(panelServers.map((server) => server.id));
    const staleServerIds = [
      ...new Set(
        useServerPanelDockStore
          .getState()
          .tabs.filter((tab) => !validIds.has(tab.serverId))
          .map((tab) => tab.serverId),
      ),
    ];
    for (const serverId of staleServerIds) {
      removeServerTabs(serverId);
    }
  }, [panelServers, removeServerTabs]);

  const handleNavigate = useCallback(
    (target: ServerSidebarNavTarget, mode: ServerPanelDockOpenMode = "permanent") => {
      selectServer(target.serverId, mode);
      setNavTarget(target);
      if (target.itemId && target.detailTab) {
        setActiveNavKey(makeServerTreeKey(target.serverId, target.detailTab, target.itemId));
      } else if (target.detailTab) {
        setActiveNavKey(makeServerTreeKey(target.serverId, target.detailTab));
      } else {
        setActiveNavKey(makeServerTreeKey(target.serverId));
      }
    },
    [selectServer],
  );

  const handleCreateServer = useCallback(() => {
    setEditPanelConnection(undefined);
    setShowDialog(true);
  }, []);

  const handleEditServer = useCallback(
    (server: ServerEntry) => {
      const conn = connections.find((c) => c.id === server.id);
      setEditPanelConnection(conn);
      setShowDialog(true);
    },
    [connections],
  );

  const handleDeleteServer = useCallback(
    async (serverId: string) => {
      if (!(await appConfirm(t("server.sidebar.delete")))) return;
      removeServerTabs(serverId);
      await removeConn(serverId);
    },
    [removeConn, removeServerTabs, t],
  );

  const moduleDockTabs = useMemo(
    () =>
      dockTabs
        .map((tab) => {
          const server = serverById.get(tab.serverId);
          if (!server) return null;
          return {
            id: tab.id,
            label: server.name,
            panelType: "server-panel",
            closable: true,
            preview: tab.preview,
            tooltip: server.address,
          };
        })
        .filter((tab): tab is NonNullable<typeof tab> => tab != null),
    [dockTabs, serverById],
  );

  const renderServerPanel = useCallback(
    (tabId: string) => {
      const tab = dockTabs.find((item) => item.id === tabId);
      if (!tab) {
        return <div className="server-panel-tab-pane" aria-hidden />;
      }
      const server = serverById.get(tab.serverId);
      if (!server) {
        return <div className="server-panel-tab-pane" aria-hidden />;
      }
      return (
        <div className="server-main">
          <ServerDockPanel
            server={server}
            isActive={activeTabId === tabId}
            moduleLive={moduleLive}
            navTarget={navTarget?.serverId === server.id ? navTarget : null}
          />
        </div>
      );
    },
    [activeTabId, dockTabs, moduleLive, navTarget, serverById],
  );

  const sidebarLinkageValue = useMemo(
    () => ({
      activeServerId,
      activeNavKey,
      onNavigate: handleNavigate,
    }),
    [activeNavKey, activeServerId, handleNavigate],
  );

  return (
    <>
      <ServerSidebarLinkageProvider value={sidebarLinkageValue}>
        <ModuleWorkspaceLayout
          className="server-panels-workspace"
          leftColumnTitle={t("routes.server")}
          leftPreset="server"
          leftSidebar={
            <ServerPanelSidebar
              servers={panelServers}
              onCreateServer={handleCreateServer}
              onEditServer={handleEditServer}
              onDeleteServer={handleDeleteServer}
            />
          }
        >
          <ModuleSegmentDock
            className="server-module-dock"
            variant="workspace"
            dockScope="server-panel"
            tabs={moduleDockTabs}
            activeTabId={activeTabId ?? ""}
            onActiveTabChange={setActiveTabId}
            onCloseTab={closeTab}
            enabled={isActiveRoute}
            savedLayout={dockLayout}
            onSavedLayoutChange={setDockLayout}
            renderPanel={renderServerPanel}
            emptyContent={
              <WorkspaceEmptyPage
                title={t("routes.server")}
                prompt={t("server.empty.selectServer")}
              />
            }
          />
        </ModuleWorkspaceLayout>
      </ServerSidebarLinkageProvider>
      <ServerConnectionDialog
        open={showDialog}
        onClose={() => setShowDialog(false)}
        onSaved={() => setShowDialog(false)}
        editPanelConnection={editPanelConnection}
      />
    </>
  );
}
