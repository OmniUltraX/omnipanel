import { useMemo, useState } from "react";
import { useI18n } from "../../i18n";
import { Button } from "../ui/Button";
import { ContextMenu, type ContextMenuItem } from "../ui/ContextMenu";
import type { DockerConnectionInfo } from "../../ipc/bindings";

const SOURCE_LABEL: Record<string, string> = {
  "local-engine": "本地 Engine",
  "remote-engine": "远程 Engine",
  "ssh-engine": "SSH 宿主机",
  onepanel: "1Panel",
  "panel-adapter": "面板",
};

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
  onSelect: (connectionId: string) => void;
  onCreate: () => void;
  onScan?: () => void;
  onEditConnection?: (connection: DockerConnectionInfo) => void;
  onDeleteConnection?: (connectionId: string) => void;
}

export function DockerSidebar({
  connections,
  activeConnectionId,
  loading,
  scanning,
  onSelect,
  onCreate,
  onScan,
  onEditConnection,
  onDeleteConnection,
}: DockerSidebarProps) {
  const { t } = useI18n();
  const [ctxPos, setCtxPos] = useState<{ x: number; y: number } | null>(null);
  const [ctxConnection, setCtxConnection] = useState<DockerConnectionInfo | null>(null);

  const sorted = useMemo(
    () => [...connections].sort((a, b) => a.name.localeCompare(b.name)),
    [connections],
  );

  const handleContextMenu = (e: React.MouseEvent, connection: DockerConnectionInfo) => {
    e.preventDefault();
    setCtxPos({ x: e.clientX, y: e.clientY });
    setCtxConnection(connection);
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

  return (
    <div className="server-sidebar docker-sidebar">
      <div className="server-sidebar-header">
        <span className="docker-sidebar-title">{t("docker.sidebar.title")}</span>
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
      </div>
      <div className="server-sidebar-subheader">
        <span>{t("docker.sidebar.connections")}</span>
        <span className="badge badge-muted">{connections.length}</span>
      </div>
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
              onClick={() => onSelect(conn.connectionId)}
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
}
