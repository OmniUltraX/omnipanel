import { useCallback, useEffect, useMemo, useState } from "react";
import { SidebarWorkspace } from "../../components/ui/SidebarWorkspace";
import { ServerSidebar } from "../../components/workspace/ServerSidebar";
import { useConnectionStore } from "../../stores/connectionStore";
import { useServerGroupStore } from "../../stores/serverGroupStore";
import { useServerTabStore } from "../../stores/serverTabStore";
import { useTopbarTabs } from "../../hooks/useTopbarTabs";
import { useI18n } from "../../i18n";
import { quickInput } from "../../lib/quickInput";
import { WorkspaceEmptyPage } from "../../components/ui/WorkspaceEmptyPage";
import { CreateServerDialog, type ServerEntry } from "./CreateServerDialog";
import { ServerInstalledApps } from "./ServerInstalledApps";
import {
  connectionMatchesServerGroup,
  connectionToServerEntry,
  serverEntryToConnection,
} from "./panelConnection";

export function ServerPanel() {
  const { t } = useI18n();
  const connections = useConnectionStore((s) => s.connections);
  const saveConnection = useConnectionStore((s) => s.save);
  const removeConnection = useConnectionStore((s) => s.remove);

  const groups = useServerGroupStore((s) => s.groups);
  const activeGroupId = useServerGroupStore((s) => s.activeGroupId);
  const setActiveGroupId = useServerGroupStore((s) => s.setActiveGroupId);
  const addGroup = useServerGroupStore((s) => s.addGroup);
  const getGroupName = useServerGroupStore((s) => s.getGroupName);

  const openServer = useServerTabStore((s) => s.openServer);
  const setActiveServer = useServerTabStore((s) => s.setActiveServer);
  const closeServer = useServerTabStore((s) => s.closeServer);
  const pruneServers = useServerTabStore((s) => s.pruneServers);
  const openServerIds = useServerTabStore(
    (s) => s.byGroup[activeGroupId]?.openServerIds ?? [],
  );
  const activeServerId = useServerTabStore(
    (s) => s.byGroup[activeGroupId]?.activeServerId ?? null,
  );

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<ServerEntry | null>(null);

  const activeGroupName = useMemo(
    () => getGroupName(activeGroupId),
    [activeGroupId, getGroupName],
  );

  const groupServers = useMemo(
    () =>
      connections
        .filter((c) => c.kind === "panel" && connectionMatchesServerGroup(c, activeGroupName))
        .map(connectionToServerEntry),
    [connections, activeGroupName],
  );

  const serverById = useMemo(
    () => new Map(groupServers.map((server) => [server.id, server])),
    [groupServers],
  );

  const openServers = useMemo(
    () =>
      openServerIds
        .map((id) => serverById.get(id))
        .filter((server): server is ServerEntry => Boolean(server)),
    [openServerIds, serverById],
  );

  const activeServer = useMemo(() => {
    if (!activeServerId) return null;
    return serverById.get(activeServerId) ?? null;
  }, [activeServerId, serverById]);

  const unopenedServers = useMemo(
    () => groupServers.filter((server) => !openServerIds.includes(server.id)),
    [groupServers, openServerIds],
  );

  useEffect(() => {
    pruneServers(
      activeGroupId,
      groupServers.map((server) => server.id),
    );
  }, [activeGroupId, groupServers, pruneServers]);

  const handleOpenServer = useCallback(
    (serverId: string) => {
      openServer(activeGroupId, serverId);
    },
    [activeGroupId, openServer],
  );

  const handleCreateServer = useCallback(
    async (entry: ServerEntry) => {
      await saveConnection(serverEntryToConnection(entry, activeGroupName));
    },
    [activeGroupName, saveConnection],
  );

  const handleUpdateServer = useCallback(
    async (entry: ServerEntry) => {
      const existing = useConnectionStore.getState().connections.find((c) => c.id === entry.id);
      const group = existing?.group ?? activeGroupName;
      await saveConnection(serverEntryToConnection(entry, group));
    },
    [activeGroupName, saveConnection],
  );

  const handleDeleteServer = useCallback(
    async (resourceId: string) => {
      await removeConnection(resourceId);
    },
    [removeConnection],
  );

  const handleSidebarCreate = useCallback(() => {
    setEditingServer(null);
    setDialogOpen(true);
  }, []);

  const handleEditServer = useCallback((server: ServerEntry) => {
    setEditingServer(server);
    setDialogOpen(true);
  }, []);

  const handleDialogClose = useCallback(() => {
    setDialogOpen(false);
    setEditingServer(null);
  }, []);

  const handleCreateGroup = useCallback(async () => {
    const name = await quickInput({
      title: t("server.groups.createTitle"),
      subtitle: t("server.groups.nameLabel"),
      placeholder: t("server.groups.namePlaceholder"),
      validate: (value) => {
        if (!value.trim()) {
          return t("server.groups.nameRequired");
        }
        if (groups.some((group) => group.name === value.trim())) {
          return t("server.groups.duplicate");
        }
        return null;
      },
    });
    if (name) {
      addGroup(name);
    }
  }, [addGroup, groups, t]);

  const topbarTabs = useMemo(
    () =>
      openServers.map((server) => ({
        id: server.id,
        label: server.name,
        active: server.id === activeServerId,
        closable: true,
      })),
    [openServers, activeServerId],
  );

  const addMenuItems = useMemo(
    () =>
      unopenedServers.map((server) => ({
        id: server.id,
        label: server.name,
        subtitle: server.address,
      })),
    [unopenedServers],
  );

  useTopbarTabs(
    topbarTabs,
    {
      onSelect: (id) => setActiveServer(activeGroupId, id),
      onClose: (id) => closeServer(activeGroupId, id),
      addMenuItems,
      onAddMenuSelect: (id) => handleOpenServer(id),
    },
    {
      mode: "session",
      showAddTab: unopenedServers.length > 0,
      addTabTitle: t("server.tabs.openServer"),
    },
  );

  return (
    <>
      <SidebarWorkspace
        preset="server"
        sidebar={
          <ServerSidebar
            servers={groupServers}
            groups={groups}
            activeGroupId={activeGroupId}
            activeServerId={activeServerId}
            onGroupChange={setActiveGroupId}
            onCreateGroup={() => void handleCreateGroup()}
            onSelectServer={handleOpenServer}
            onCreateServer={handleSidebarCreate}
            onEditServer={handleEditServer}
            onDeleteServer={handleDeleteServer}
          />
        }
      >
        <div className="server-main">
          {activeServer ? (
            <ServerInstalledApps server={activeServer} />
          ) : (
            <WorkspaceEmptyPage hint={t("server.empty.selectServer")} />
          )}
        </div>
      </SidebarWorkspace>
      <CreateServerDialog
        open={dialogOpen}
        editServer={editingServer}
        onClose={handleDialogClose}
        onCreate={handleCreateServer}
        onUpdate={handleUpdateServer}
      />
    </>
  );
}
