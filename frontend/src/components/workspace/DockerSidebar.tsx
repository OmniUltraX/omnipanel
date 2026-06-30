import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import { Button } from "../ui/Button";
import { ContextMenu, type ContextMenuItem } from "../ui/ContextMenu";
import {
  VerticalSplitSidebarSection,
  type VerticalSplitSidebarSectionConfig,
} from "../ui/VerticalSplitSidebar";
import type { DockerConnectionInfo } from "../../ipc/bindings";
import { isBuiltinLocalDockerConnection } from "../../modules/docker/constants";
import type { DockerConnectionDockOpenMode } from "../../modules/docker/dockerConnectionWorkspaceTabs";

const SOURCE_LABEL: Record<string, string> = {
  "local-engine": "本地 Engine",
  "remote-engine": "远程 Engine",
  "ssh-engine": "SSH 宿主机",
  onepanel: "1Panel",
  "panel-adapter": "面板",
};

const CONNECTION_LABEL_CLICK_DELAY_MS = 200;

function statusDotClass(status: DockerConnectionInfo["status"]): string {
  if (status === "online") return "online";
  if (status === "degraded") return "warning";
  return "offline";
}

interface DockerSidebarProps {
  connections: DockerConnectionInfo[];
  activeConnectionId: string | null;
  loading?: boolean;
  scanning?: boolean;
  onSelectConnection: (connectionId: string, mode?: DockerConnectionDockOpenMode) => void;
  /** @deprecated 请使用 onSelectConnection */
  onSelect?: (connectionId: string) => void;
  onCreate: () => void;
  onScan?: () => void;
  onEditConnection?: (connection: DockerConnectionInfo) => void;
  onDeleteConnection?: (connectionId: string) => void;
  section?: VerticalSplitSidebarSectionConfig;
}

export function DockerSidebar({
  connections,
  activeConnectionId,
  loading,
  scanning,
  onSelectConnection,
  onSelect,
  onCreate,
  onScan,
  onEditConnection,
  onDeleteConnection,
  section,
}: DockerSidebarProps) {
  const { t } = useI18n();
  const [ctxPos, setCtxPos] = useState<{ x: number; y: number } | null>(null);
  const [ctxConnection, setCtxConnection] = useState<DockerConnectionInfo | null>(null);
  const labelClickTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (labelClickTimerRef.current !== null) {
        window.clearTimeout(labelClickTimerRef.current);
      }
    },
    [],
  );

  const sorted = useMemo(
    () => [...connections].sort((a, b) => a.name.localeCompare(b.name)),
    [connections],
  );

  const handleContextMenu = (e: React.MouseEvent, connection: DockerConnectionInfo) => {
    if (isBuiltinLocalDockerConnection(connection.connectionId)) return;
    e.preventDefault();
    setCtxPos({ x: e.clientX, y: e.clientY });
    setCtxConnection(connection);
  };

  const handleConnectionClick = (connectionId: string) => {
    const select = onSelectConnection ?? onSelect;
    if (!select) return;
    if (onSelectConnection) {
      if (labelClickTimerRef.current !== null) {
        window.clearTimeout(labelClickTimerRef.current);
      }
      labelClickTimerRef.current = window.setTimeout(() => {
        labelClickTimerRef.current = null;
        onSelectConnection(connectionId, "preview");
      }, CONNECTION_LABEL_CLICK_DELAY_MS);
      return;
    }
    onSelect?.(connectionId);
  };

  const handleConnectionDoubleClick = (connectionId: string) => {
    if (labelClickTimerRef.current !== null) {
      window.clearTimeout(labelClickTimerRef.current);
      labelClickTimerRef.current = null;
    }
    if (onSelectConnection) {
      onSelectConnection(connectionId, "permanent");
      return;
    }
    onSelect?.(connectionId);
  };

  const ctxItems: ContextMenuItem[] = [
    {
      id: "edit",
      label: t("docker.sidebar.edit"),
      onClick: () => ctxConnection && onEditConnection?.(ctxConnection),
    },
    {
      id: "delete",
      label: t("docker.sidebar.delete"),
      danger: true,
      onClick: () => ctxConnection && onDeleteConnection?.(ctxConnection.connectionId),
    },
  ];

  const toolbar = (
    <>
      {onScan && (
        <Button
          type="button"
          variant="icon"
          className="server-sidebar-group-add"
          title={t("docker.sidebar.scanSsh")}
          disabled={scanning}
          onClick={onScan}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M23 4v6h-6" />
            <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
          </svg>
        </Button>
      )}
      <Button
        type="button"
        variant="icon"
        className="server-sidebar-add"
        title={t("docker.sidebar.addConnection")}
        onClick={onCreate}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </Button>
    </>
  );

  const panelBody = (
    <div className="server-sidebar docker-sidebar">
      {!section ? (
        <>
          <div className="server-sidebar-header window-drag-surface" data-tauri-drag-region>
            <span className="docker-sidebar-title">{t("docker.sidebar.title")}</span>
            {toolbar}
          </div>
          <div className="server-sidebar-subheader window-drag-surface" data-tauri-drag-region>
            <span>{t("docker.sidebar.connections")}</span>
            <span className="badge badge-muted">{connections.length}</span>
          </div>
        </>
      ) : null}
      <div className="server-sidebar-body">
        {loading ? (
          <div className="empty-state compact">{t("docker.sidebar.loading")}</div>
        ) : sorted.length === 0 ? (
          <div className="empty-state compact">{t("docker.sidebar.empty")}</div>
        ) : (
          sorted.map((conn) => (
            <button
              key={conn.connectionId}
              type="button"
              className={`server-item${activeConnectionId === conn.connectionId ? " active" : ""}`}
              onClick={() => handleConnectionClick(conn.connectionId)}
              onDoubleClick={() => handleConnectionDoubleClick(conn.connectionId)}
              onContextMenu={(e) => handleContextMenu(e, conn)}
            >
              <span className={`status-dot ${statusDotClass(conn.status)}`} />
              <div className="server-item__main">
                <div className="server-item__row1">
                  <span className="server-item__name">{conn.name}</span>
                </div>
                <div className="server-item__address">
                  {SOURCE_LABEL[conn.source] ?? conn.source}
                  {conn.hostLabel ? ` · ${conn.hostLabel}` : ""}
                </div>
              </div>
            </button>
          ))
        )}
      </div>
      {ctxPos && (
        <ContextMenu
          items={ctxItems}
          position={ctxPos}
          onClose={() => {
            setCtxPos(null);
            setCtxConnection(null);
          }}
        />
      )}
    </div>
  );

  if (section) {
    return (
      <VerticalSplitSidebarSection
        {...section}
        actions={
          <>
            <span className="badge badge-muted">{connections.length}</span>
            {toolbar}
          </>
        }
      >
        {panelBody}
      </VerticalSplitSidebarSection>
    );
  }

  return panelBody;
}
