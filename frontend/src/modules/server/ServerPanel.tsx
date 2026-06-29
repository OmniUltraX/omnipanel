import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { ModuleSegmentDock } from "../../components/dock";
import { ModuleWorkspaceLayout } from "../../components/workspace";
import { WorkspaceEmptyPage } from "../../components/ui/WorkspaceEmptyPage";
import { useConnectionStore } from "../../stores/connectionStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useI18n } from "../../i18n";
import { appConfirm } from "../../lib/appConfirm";
import {
  ServerWorkspace,
  useServerWorkspaceTabState,
  useServerWorkspaceTabs,
  type ServerWorkspaceTab,
} from "./panel/ServerWorkspace";
import { ServerConnectionDialog } from "./panel/ServerConnectionDialog";
import { useServerPanelWorkspace } from "./panel/hooks/useServerPanelWorkspace";
import { ServerPanelSidebar } from "./panel/ServerPanelSidebar";
import { ServerSidebarLinkageProvider } from "./panel/ServerSidebarLinkageContext";
import type { ServerPanelDockOpenMode } from "./panel/serverPanelWorkspaceTabs";
import { SERVER_PATH } from "./panel/constants";
import { connectionToServerEntry } from "./panel/panelConnection";
import type { ServerEntry } from "./panel/serverConnection";
import type { Connection } from "../../ipc/bindings";

export function ServerPanel() {
  const { t } = useI18n();
  const location = useLocation();
  const isActiveRoute = location.pathname === "/module/server";
  const connections = useConnectionStore((s) => s.connections);
  const removeConn = useConnectionStore((s) => s.remove);
  const selectedResourceByPath = useWorkspaceStore((s) => s.selectedResourceByPath);
  const selectResource = useWorkspaceStore((s) => s.selectResource);

  const panelServers = useMemo(
    () => connections.filter((c) => c.kind === "panel").map(connectionToServerEntry),
    [connections],
  );

  const activeServerId = selectedResourceByPath[SERVER_PATH] ?? panelServers[0]?.id ?? null;

  const serverWorkspace = useServerPanelWorkspace(panelServers);

  const [showDialog, setShowDialog] = useState(false);
  const [editPanelConnection, setEditPanelConnection] = useState<Connection | undefined>();
  const [tab, setTab] = useServerWorkspaceTabState();
  const topbarTabs = useServerWorkspaceTabs(tab);

  const segmentTabs = useMemo(
    () => topbarTabs.map(({ id, label }) => ({ id, label })),
    [topbarTabs],
  );

  const resolvedServerId = serverWorkspace.activeServerId ?? activeServerId;

  const sidebarLinkageValue = useMemo(
    () => ({
      activeServerId: resolvedServerId,
    }),
    [resolvedServerId],
  );

  useEffect(() => {
    if (!selectedResourceByPath[SERVER_PATH] && panelServers[0]) {
      selectResource(panelServers[0].id, SERVER_PATH);
    }
  }, [panelServers, selectedResourceByPath, selectResource]);

  const handleSidebarSelectServer = useCallback(
    (serverId: string, mode?: ServerPanelDockOpenMode) => {
      serverWorkspace.handleSelectServer(serverId, mode);
      selectResource(serverId, SERVER_PATH);
    },
    [selectResource, serverWorkspace],
  );

  useEffect(() => {
    if (!activeServerId) {
      return;
    }
    const { activeServerId: workspaceActiveId, handleSelectServer } = serverWorkspace;
    if (workspaceActiveId !== activeServerId) {
      handleSelectServer(activeServerId, "permanent");
    }
  }, [
    activeServerId,
    serverWorkspace.activeServerId,
    serverWorkspace.handleSelectServer,
  ]);

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
      await removeConn(serverId);
    },
    [removeConn, t],
  );

  const renderServerSegmentContent = useCallback(
    (segmentTabId: ServerWorkspaceTab, serverId: string, isActive: boolean) => {
      if (!isActive) {
        return <div className="server-panel-tab-pane" aria-hidden />;
      }

      const server = panelServers.find((item) => item.id === serverId);
      if (!server) {
        return <div className="server-panel-tab-pane" aria-hidden />;
      }

      return (
        <div className="server-main">
          <ServerWorkspace server={server} tab={segmentTabId} />
        </div>
      );
    },
    [panelServers],
  );

  return (
    <>
      <ServerSidebarLinkageProvider value={sidebarLinkageValue}>
        <ModuleWorkspaceLayout
          layoutKey="server-panels"
          className="server-panels-workspace"
          leftColumnTitle={t("routes.server")}
          leftPreset="server"
          leftSidebar={
            <ServerPanelSidebar
              servers={panelServers}
              onSelectServer={handleSidebarSelectServer}
              onCreateServer={handleCreateServer}
              onEditServer={handleEditServer}
              onDeleteServer={handleDeleteServer}
            />
          }
        >
          <ModuleSegmentDock
            className="server-module-dock"
            variant="function"
            tabs={segmentTabs}
            activeTabId={tab}
            onActiveTabChange={(id) => setTab(id as ServerWorkspaceTab)}
            enabled={isActiveRoute}
            panelContentKey={resolvedServerId ?? "none"}
            renderPanel={(segmentTabId) =>
              resolvedServerId ? (
                renderServerSegmentContent(segmentTabId as ServerWorkspaceTab, resolvedServerId, true)
              ) : (
                <WorkspaceEmptyPage
                  title={t("routes.server")}
                  prompt={t("server.empty.selectServer")}
                />
              )
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
