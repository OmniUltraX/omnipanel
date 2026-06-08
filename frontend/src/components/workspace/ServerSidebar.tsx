import { useMemo, useState } from "react";
import { useI18n } from "../../i18n";
import { ContextMenu, type ContextMenuItem } from "../ui/ContextMenu";
import { Button } from "../ui/Button";
import { Select } from "../ui/Select";
import type { ServerEntry } from "../../modules/server/panel/serverConnection";
import type { ServerConnectionGroup } from "../../stores/serverGroupStore";

interface ServerSidebarProps {
  servers: ServerEntry[];
  groups: ServerConnectionGroup[];
  activeGroupId: string;
  activeServerId: string | null;
  onGroupChange: (groupId: string) => void;
  onCreateGroup: () => void;
  onSelectServer: (serverId: string) => void;
  onCreateServer?: () => void;
  onEditServer?: (server: ServerEntry) => void;
  onDeleteServer?: (serverId: string) => void;
}

export function ServerSidebar({
  servers,
  groups,
  activeGroupId,
  activeServerId,
  onGroupChange,
  onCreateGroup,
  onSelectServer,
  onCreateServer,
  onEditServer,
  onDeleteServer,
}: ServerSidebarProps) {
  const { t } = useI18n();

  const [ctxPos, setCtxPos] = useState<{ x: number; y: number } | null>(null);
  const [ctxServer, setCtxServer] = useState<ServerEntry | null>(null);

  const sortedServers = useMemo(
    () => [...servers].sort((a, b) => a.name.localeCompare(b.name)),
    [servers],
  );

  const handleContextMenu = (e: React.MouseEvent, server: ServerEntry) => {
    e.preventDefault();
    setCtxPos({ x: e.clientX, y: e.clientY });
    setCtxServer(server);
  };

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
      onClick: () => ctxServer && onDeleteServer?.(ctxServer.id),
    },
  ];

  return (
    <div className="server-sidebar">
      <div className="server-sidebar-header">
        <Select
          className="server-sidebar-group-select"
          value={activeGroupId}
          onChange={onGroupChange}
          aria-label={t("server.groups.nameLabel")}
          searchable={groups.length >= 8}
          options={groups.map((group) => ({ value: group.id, label: group.name }))}
        />
        <Button
          type="button"
          variant="icon"
          className="server-sidebar-group-add"
          title={t("server.groups.new")}
          onClick={onCreateGroup}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </Button>
        <Button
          type="button"
          variant="icon"
          className="server-sidebar-add"
          title={t("server.sidebar.addServer")}
          onClick={onCreateServer}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </Button>
      </div>
      <div className="server-sidebar-subheader">
        <span>{t("server.sidebar.title")}</span>
        <span className="badge badge-muted">{servers.length}</span>
      </div>
      <div className="server-sidebar-body">
        {sortedServers.length === 0 ? (
          <div className="empty-state compact">{t("common.noResources")}</div>
        ) : (
          sortedServers.map((server) => (
            <button
              key={server.id}
              type="button"
              className={`server-item${activeServerId === server.id ? " active" : ""}`}
              onClick={() => onSelectServer(server.id)}
              onContextMenu={(e) => handleContextMenu(e, server)}
            >
              <div className="server-item__main">
                <div className="server-item__row1">
                  <span className="server-item__name">{server.name}</span>
                  <span
                    className={`badge badge-muted server-item__type-tag server-item__type-tag--${server.serviceType === "bt" ? "bt" : "onepanel"}`}
                  >
                    {t(`server.serviceType.${server.serviceType}`)}
                  </span>
                </div>
                <div className="server-item__address">{server.address}</div>
              </div>
            </button>
          ))
        )}
      </div>
      {ctxPos && (
        <ContextMenu
          items={ctxItems}
          position={ctxPos}
          onClose={() => setCtxPos(null)}
        />
      )}
    </div>
  );
}
