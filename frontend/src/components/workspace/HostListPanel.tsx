import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  type EnvironmentTag,
  type WorkspaceResource,
} from "../../lib/resourceRegistry";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useI18n } from "../../i18n";
import { useHostOnlineStatus } from "../../stores/sshConnectionStore";
import { useSshStats } from "../../stores/sshStatsStore";
import { useConnectionStore } from "../../stores/connectionStore";
import { isOpenSshHostId, getOpenSshConfigEntry, openSshHostAlias } from "../../lib/sshConfigHosts";
import { ContextMenu, type ContextMenuItem } from "../ui/ContextMenu";
import { SshConnectionDialog } from "../../modules/ssh/SshConnectionDialog";
import type { Connection } from "../../ipc/bindings";

const HOST_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="2" y="2" width="20" height="8" rx="2" />
    <rect x="2" y="14" width="20" height="8" rx="2" />
    <circle cx="6" cy="6" r="1" fill="currentColor" />
  </svg>
);

interface HostListPanelProps {
  resources: WorkspaceResource[];
  onConnect?: (hostId: string) => void;
}

const SSH_PATH = "/ssh";

function HostStatusDot({ resourceId }: { resourceId: string }) {
  const status = useHostOnlineStatus(resourceId);

  const cls =
    status === "online"
      ? "host-status host-status--online"
      : status === "connecting"
        ? "host-status host-status--connecting"
        : status === "error"
          ? "host-status host-status--error"
          : "host-status host-status--unknown";

  const title =
    status === "online"
      ? "SSH 端口可达"
      : status === "connecting"
        ? "正在探测"
        : status === "error"
          ? "SSH 端口不可达"
          : "未知";

  return <span className={cls} title={title} />;
}

function HostOsInfo({ resourceId }: { resourceId: string }) {
  const stats = useSshStats(resourceId);
  if (!stats?.osInfo) return null;
  return <span className="host-os-tag">{stats.osInfo}</span>;
}

export function HostListPanel({ resources, onConnect }: HostListPanelProps) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const selectedResourceByPath = useWorkspaceStore((s) => s.selectedResourceByPath);
  const selectResource = useWorkspaceStore((s) => s.selectResource);
  const setActivePath = useWorkspaceStore((s) => s.setActivePath);
  const connections = useConnectionStore((s) => s.connections);
  const removeConn = useConnectionStore((s) => s.remove);
  const activeHostId = selectedResourceByPath[SSH_PATH];

  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; host: WorkspaceResource } | null>(null);
  const [showDialog, setShowDialog] = useState(false);
  const [editConnection, setEditConnection] = useState<Connection | undefined>(undefined);
  const [deleting, setDeleting] = useState(false);

  const grouped = useMemo(() => {
    const filtered = resources.filter(
      (r) =>
        r.name.toLowerCase().includes(query.toLowerCase()) ||
        r.subtitle.toLowerCase().includes(query.toLowerCase())
    );
    const order: EnvironmentTag[] = ["prod", "staging", "dev", "local", "unknown"];
    return order
      .map((env) => ({
        env,
        label: t(`env.${env}`),
        items: filtered.filter((r) => r.environment === env),
      }))
      .filter((g) => g.items.length > 0);
  }, [resources, query, t]);

  const selectHost = (resource: WorkspaceResource) => {
    selectResource(resource.id, SSH_PATH);
    setActivePath(SSH_PATH);
    navigate(SSH_PATH);
  };

  const handleContextMenu = (e: React.MouseEvent, host: WorkspaceResource) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, host });
  };

  const handleDelete = async () => {
    if (!ctxMenu || deleting) return;
    const host = ctxMenu.host;
    setCtxMenu(null);
    if (isOpenSshHostId(host.id)) {
      alert(t("ssh.dialog.configHostDeleteWarn"));
      return;
    }
    if (!window.confirm(t("ssh.dialog.confirmDelete", { name: host.name }))) return;
    setDeleting(true);
    try {
      await removeConn(host.id);
    } catch { /* ignore */ }
    setDeleting(false);
  };

  const handleEdit = () => {
    if (!ctxMenu) return;
    const host = ctxMenu.host;
    setCtxMenu(null);
    const conn = connections.find((c) => c.id === host.id);
    if (conn) {
      setEditConnection(conn);
      setShowDialog(true);
    } else if (isOpenSshHostId(host.id)) {
      const alias = openSshHostAlias(host.id);
      const entry = alias ? getOpenSshConfigEntry(host.id) : null;
      if (entry) {
        const config = JSON.stringify({
          host: entry.hostName,
          port: entry.port ?? 22,
          user: entry.user ?? "root",
          auth: { type: "password", password: "" },
        });
        const prefill: Connection = {
          id: "",
          kind: "ssh",
          name: host.name,
          group: "默认",
          envTag: "unknown",
          config,
        };
        setEditConnection(prefill);
        setShowDialog(true);
      }
    }
  };

  const handleAdd = () => {
    setEditConnection(undefined);
    setShowDialog(true);
  };

  const ctxItems: ContextMenuItem[] = [
    { label: t("ssh.dialog.edit"), onClick: handleEdit },
    { label: t("ssh.dialog.delete"), onClick: handleDelete, danger: true },
  ];

  return (
    <div className="host-list-panel">
      <div className="host-list-header">
        <h3>{t("ssh.sidebar.title")}</h3>
        <span className="badge badge-muted">{resources.length}</span>
        <button className="btn btn-icon host-add-btn" title={t("ssh.dialog.addTitle")} onClick={handleAdd}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
        </button>
      </div>
      <div className="host-list-search">
        <input
          className="input input-search"
          placeholder={t("ssh.sidebar.search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ width: "100%" }}
        />
      </div>
      <div className="host-list">
        {grouped.length === 0 ? (
          <div className="empty-state compact">{t("common.noResources")}</div>
        ) : (
          grouped.map((group) => (
            <div key={group.env}>
              <div className="host-group-label">{group.label}</div>
              {group.items.map((host) => (
                <div
                  key={host.id}
                  className={`host-item-row${activeHostId === host.id ? " active" : ""}`}
                  onContextMenu={(e) => handleContextMenu(e, host)}
                >
                  <button
                    type="button"
                    className="host-item"
                    onClick={() => selectHost(host)}
                    onDoubleClick={() => onConnect?.(host.id)}
                  >
                    <div className="host-icon">{HOST_ICON}</div>
                    <div className="host-info">
                      <div className="host-row-1">
                        <span className="host-name">{host.name}</span>
                        <HostOsInfo resourceId={host.id} />
                      </div>
                      <div className="host-row-2">{host.subtitle}</div>
                    </div>
                  </button>
                  <HostStatusDot resourceId={host.id} />
                </div>
              ))}
            </div>
          ))
        )}
      </div>

      {ctxMenu && (
        <ContextMenu
          items={ctxItems}
          position={{ x: ctxMenu.x, y: ctxMenu.y }}
          onClose={() => setCtxMenu(null)}
        />
      )}

      <SshConnectionDialog
        open={showDialog}
        onClose={() => { setShowDialog(false); setEditConnection(undefined); }}
        onSaved={() => {
          useConnectionStore.getState().refresh();
          useConnectionStore.getState().refresh();
        }}
        editConnection={editConnection}
      />
    </div>
  );
}
