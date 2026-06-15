import { useCallback, useEffect, useMemo, useState } from "react";
import { commands } from "../../ipc/bindings";
import type { SshTunnelInfo } from "../../ipc/bindings";
import type { WorkspaceResource } from "../../lib/resourceRegistry";
import { useI18n } from "../../i18n";
import { Button } from "../ui/Button";
import { Select } from "../ui/Select";

export type TunnelPanelProps = {
  activeResource: WorkspaceResource | null;
};

export function TunnelPanel({ activeResource }: TunnelPanelProps) {
  const { t } = useI18n();
  const [tunnels, setTunnels] = useState<SshTunnelInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [tunnelType, setTunnelType] = useState<"local" | "remote" | "dynamic">("local");
  const [localPort, setLocalPort] = useState("");
  const [remoteHost, setRemoteHost] = useState("");
  const [remotePort, setRemotePort] = useState("");
  const [error, setError] = useState<string | null>(null);

  const hostId = activeResource?.id ?? "";

  const hostTunnels = useMemo(
    () => tunnels.filter((tunnel) => tunnel.connectionId === hostId),
    [tunnels, hostId],
  );

  const loadTunnels = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await commands.sshListTunnels();
      if (res.status === "ok") {
        setTunnels(res.data);
      } else {
        setError(res.error.message);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTunnels();
  }, [loadTunnels]);

  const handleCreate = async () => {
    if (!hostId || !localPort || !remoteHost || !remotePort) {
      setError(t("ssh.tunnels.formRequired"));
      return;
    }
    try {
      const res = await commands.sshCreateTunnel(
        hostId,
        tunnelType,
        parseInt(localPort, 10),
        remoteHost,
        parseInt(remotePort, 10),
      );
      if (res.status === "ok") {
        setShowCreate(false);
        setLocalPort("");
        setRemoteHost("");
        setRemotePort("");
        loadTunnels();
      } else {
        setError(res.error.message);
      }
    } catch (e) {
      setError(String(e));
    }
  };

  const handleClose = async (tunnelId: string) => {
    try {
      const res = await commands.sshCloseTunnel(tunnelId);
      if (res.status === "ok") {
        loadTunnels();
      } else {
        setError(res.error.message);
      }
    } catch (e) {
      setError(String(e));
    }
  };

  if (!activeResource) {
    return <div className="empty-state compact">{t("ssh.empty.selectHost")}</div>;
  }

  return (
    <div className="tunnel-panel">
      <div className="tunnel-header">
        <span className="tunnel-label">
          {t("ssh.tunnels.label")} · {activeResource.name}
        </span>
        <Button
          variant="icon"
          onClick={() => setShowCreate(!showCreate)}
          title={t("ssh.tunnels.create")}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </Button>
      </div>
      {error && <div className="sftp-error">{error}</div>}
      {showCreate && (
        <div className="tunnel-create" style={{ display: "flex", flexDirection: "column", gap: 6, padding: "8px 0" }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <Select
              className="input input-sm"
              size="sm"
              value={tunnelType}
              onChange={(v) => setTunnelType(v as typeof tunnelType)}
              style={{ width: 100 }}
              searchable={false}
              options={[
                { value: "local", label: t("ssh.tunnels.typeLocal") },
                { value: "remote", label: t("ssh.tunnels.typeRemote") },
                { value: "dynamic", label: t("ssh.tunnels.typeDynamic") },
              ]}
            />
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              className="input input-sm"
              placeholder={t("ssh.tunnels.localPort")}
              value={localPort}
              onChange={(e) => setLocalPort(e.target.value)}
              style={{ width: 100 }}
            />
            <input
              className="input input-sm"
              placeholder={t("ssh.tunnels.remoteHost")}
              value={remoteHost}
              onChange={(e) => setRemoteHost(e.target.value)}
              style={{ flex: 1 }}
            />
            <input
              className="input input-sm"
              placeholder={t("ssh.tunnels.remotePort")}
              value={remotePort}
              onChange={(e) => setRemotePort(e.target.value)}
              style={{ width: 100 }}
            />
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button className="btn btn-primary btn-sm" onClick={handleCreate}>
              {t("ssh.tunnels.create")}
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => setShowCreate(false)}>
              {t("ssh.keys.cancel")}
            </button>
          </div>
        </div>
      )}
      <div className="tunnel-list">
        {loading && <div className="empty-state compact">{t("ssh.keys.loading")}</div>}
        {!loading && hostTunnels.length === 0 && (
          <div className="empty-state compact">{t("ssh.tunnels.empty")}</div>
        )}
        {hostTunnels.map((tunnel) => (
          <div key={tunnel.id} className="tunnel-item">
            <div className="tunnel-item-main">
              <span className={`status-dot ${tunnel.status === "active" ? "online" : "offline"}`} />
              <span className={`tunnel-bind-badge ${tunnel.tunnelType}`}>
                {tunnel.tunnelType.toUpperCase()}
              </span>
              <span className="tunnel-endpoint">:{tunnel.localPort}</span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                <path d="M5 12h14M12 5l7 7-7 7" />
              </svg>
              <span className="tunnel-endpoint">
                {tunnel.remoteHost}:{tunnel.remotePort}
              </span>
              <span className="text-muted text-xs" style={{ marginLeft: 8 }}>
                {tunnel.status}
              </span>
            </div>
            <button
              className="tunnel-delete-btn"
              onClick={() => handleClose(tunnel.id)}
              title={t("ssh.tunnels.delete")}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
