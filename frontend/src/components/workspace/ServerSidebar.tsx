import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import { ContextMenu, type ContextMenuItem } from "../ui/ContextMenu";
import { Button } from "../ui/Button";
import {
  VerticalSplitSidebarSection,
  type VerticalSplitSidebarSectionConfig,
} from "../ui/VerticalSplitSidebar";
import type { ServerEntry } from "../../modules/server/panel/serverConnection";
import type { ServerPanelDockOpenMode } from "../../modules/server/panel/serverPanelWorkspaceTabs";

const SERVER_LABEL_CLICK_DELAY_MS = 200;

interface ServerSidebarProps {
  servers: ServerEntry[];
  activeServerId: string | null;
  onSelectServer: (serverId: string, mode?: ServerPanelDockOpenMode) => void;
  onCreateServer?: () => void;
  onEditServer?: (server: ServerEntry) => void;
  onDeleteServer?: (serverId: string) => void;
  section?: VerticalSplitSidebarSectionConfig;
}

export function ServerSidebar({
  servers,
  activeServerId,
  onSelectServer,
  onCreateServer,
  onEditServer,
  onDeleteServer,
  section,
}: ServerSidebarProps) {
  const { t } = useI18n();

  const [ctxPos, setCtxPos] = useState<{ x: number; y: number } | null>(null);
  const [ctxServer, setCtxServer] = useState<ServerEntry | null>(null);
  const labelClickTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (labelClickTimerRef.current !== null) {
        window.clearTimeout(labelClickTimerRef.current);
      }
    },
    [],
  );

  const sortedServers = useMemo(
    () => [...servers].sort((a, b) => a.name.localeCompare(b.name)),
    [servers],
  );

  const handleContextMenu = (e: React.MouseEvent, server: ServerEntry) => {
    e.preventDefault();
    setCtxPos({ x: e.clientX, y: e.clientY });
    setCtxServer(server);
  };

  const handleServerClick = (serverId: string) => {
    if (labelClickTimerRef.current !== null) {
      window.clearTimeout(labelClickTimerRef.current);
    }
    labelClickTimerRef.current = window.setTimeout(() => {
      labelClickTimerRef.current = null;
      onSelectServer(serverId, "preview");
    }, SERVER_LABEL_CLICK_DELAY_MS);
  };

  const handleServerDoubleClick = (serverId: string) => {
    if (labelClickTimerRef.current !== null) {
      window.clearTimeout(labelClickTimerRef.current);
      labelClickTimerRef.current = null;
    }
    onSelectServer(serverId, "permanent");
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

  const addServerButton = (
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
  );

  const panelBody = (
    <>
      <div className="server-sidebar-body">
        {sortedServers.length === 0 ? (
          <div className="empty-state compact">{t("common.noResources")}</div>
        ) : (
          sortedServers.map((server) => (
            <button
              key={server.id}
              type="button"
              className={`server-item${activeServerId === server.id ? " active" : ""}`}
              onClick={() => handleServerClick(server.id)}
              onDoubleClick={() => handleServerDoubleClick(server.id)}
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
