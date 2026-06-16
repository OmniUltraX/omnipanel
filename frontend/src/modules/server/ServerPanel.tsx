import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { SidebarWorkspace } from "../../components/ui/SidebarWorkspace";
import { ServerSidebar } from "../../components/workspace/ServerSidebar";
import { Button } from "../../components/ui/Button";
import { WorkspaceEmptyPage } from "../../components/ui/WorkspaceEmptyPage";
import { ModuleSegmentDock } from "../../components/dock";
import { useConnectionStore } from "../../stores/connectionStore";
import { useServerGroupStore } from "../../stores/serverGroupStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useI18n } from "../../i18n";
import {
  ServerWorkspace,
  useServerWorkspaceTabState,
  useServerWorkspaceTabs,
  type ServerWorkspaceTab,
} from "./panel/ServerWorkspace";
import { ServerConnectionDialog } from "./panel/ServerConnectionDialog";
import { SERVER_PATH } from "./panel/constants";
import {
  connectionMatchesServerGroup,
  connectionToServerEntry,
} from "./panel/panelConnection";
import type { ServerEntry } from "./panel/serverConnection";
import type { Connection } from "../../ipc/bindings";

export function ServerPanel() {
  const { t } = useI18n();
  const location = useLocation();
  const isActiveRoute = location.pathname === "/server";
  const connections = useConnectionStore((s) => s.connections);
  const removeConn = useConnectionStore((s) => s.remove);
  const groups = useServerGroupStore((s) => s.groups);
  const activeGroupId = useServerGroupStore((s) => s.activeGroupId);
  const setActiveGroupId = useServerGroupStore((s) => s.setActiveGroupId);
  const addGroup = useServerGroupStore((s) => s.addGroup);
  const getGroupName = useServerGroupStore((s) => s.getGroupName);
  const selectedResourceByPath = useWorkspaceStore((s) => s.selectedResourceByPath);
  const selectResource = useWorkspaceStore((s) => s.selectResource);

  const activeGroupName = getGroupName(activeGroupId);

  const panelServers = useMemo(
    () =>
      connections
        .filter(
          (c) => c.kind === "panel" && connectionMatchesServerGroup(c, activeGroupName),
        )
        .map(connectionToServerEntry),
    [connections, activeGroupName],
  );

  const activeServerId = selectedResourceByPath[SERVER_PATH] ?? panelServers[0]?.id ?? null;
  const activeServer = useMemo(
    () => panelServers.find((s) => s.id === activeServerId) ?? null,
    [panelServers, activeServerId],
  );

  const [showDialog, setShowDialog] = useState(false);
  const [editPanelConnection, setEditPanelConnection] = useState<Connection | undefined>();
  const [tab, setTab] = useServerWorkspaceTabState();
  const topbarTabs = useServerWorkspaceTabs(tab);

  const segmentTabs = useMemo(
    () => topbarTabs.map(({ id, label }) => ({ id, label })),
    [topbarTabs],
  );

  useEffect(() => {
    if (!selectedResourceByPath[SERVER_PATH] && panelServers[0]) {
      selectResource(panelServers[0].id, SERVER_PATH);
    }
  }, [panelServers, selectedResourceByPath, selectResource]);

  const handleCreateGroup = useCallback(() => {
    const name = window.prompt(t("server.groups.namePlaceholder"));
    if (!name?.trim()) return;
    const result = addGroup(name);
    if (!result.ok && result.reason === "duplicate") {
      window.alert(t("server.groups.duplicate"));
    }
  }, [addGroup, t]);

  const handleSelectServer = useCallback(
    (serverId: string) => {
      selectResource(serverId, SERVER_PATH);
    },
    [selectResource],
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
      if (!window.confirm(t("server.sidebar.delete"))) return;
      await removeConn(serverId);
    },
    [removeConn, t],
  );

  const renderPanel = useCallback(
    (tabId: string) => (
      <SidebarWorkspace
        preset="server"
        sidebar={
          <ServerSidebar
            servers={panelServers}
            groups={groups}
            activeGroupId={activeGroupId}
            activeServerId={activeServerId}
            onGroupChange={setActiveGroupId}
            onCreateGroup={handleCreateGroup}
            onSelectServer={handleSelectServer}
            onCreateServer={handleCreateServer}
            onEditServer={handleEditServer}
            onDeleteServer={handleDeleteServer}
          />
        }
      >
        <div className="server-main">
          {activeServer ? (
            <ServerWorkspace server={activeServer} tab={tabId as ServerWorkspaceTab} />
          ) : (
            <WorkspaceEmptyPage
              prompt={t("server.empty.description")}
              actions={
                <Button variant="primary" size="sm" onClick={handleCreateServer}>
                  {t("server.sidebar.addPanel")}
                </Button>
              }
            />
          )}
        </div>
      </SidebarWorkspace>
    ),
    [
      activeGroupId,
      activeServer,
      activeServerId,
      groups,
      handleCreateGroup,
      handleCreateServer,
      handleDeleteServer,
      handleEditServer,
      handleSelectServer,
      panelServers,
      setActiveGroupId,
      t,
    ],
  );

  return (
    <>
      <ModuleSegmentDock
        className="server-module-dock"
        tabs={segmentTabs}
        activeTabId={tab}
        onActiveTabChange={(id) => setTab(id as ServerWorkspaceTab)}
        enabled={isActiveRoute}
        renderPanel={renderPanel}
      />
      <ServerConnectionDialog
        open={showDialog}
        onClose={() => setShowDialog(false)}
        onSaved={() => setShowDialog(false)}
        editPanelConnection={editPanelConnection}
        defaultGroup={activeGroupName}
      />
    </>
  );
}
