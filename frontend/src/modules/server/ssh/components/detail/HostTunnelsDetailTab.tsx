import { useCallback, useEffect, useState } from "react";
import { commands } from "../../../../../ipc/bindings";
import type { SshTunnelInfo } from "../../../../../ipc/bindings";
import { useI18n } from "../../../../../i18n";
import { Button } from "../../../../../components/ui/Button";
import { Select } from "../../../../../components/ui/Select";

export function HostTunnelsDetailTab() {
  const { t } = useI18n();
  const [tunnels, setTunnels] = useState<SshTunnelInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [tunnelType, setTunnelType] = useState<"local" | "remote" | "dynamic">("local");
  const [localPort, setLocalPort] = useState("");
  const [remoteHost, setRemoteHost] = useState("");
  const [remotePort, setRemotePort] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [error, setError] = useState<string | null>(null);

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
    if (!localPort || !remoteHost || !remotePort || !connectionId) {
      setError("请填写所有必填字段");
      return;
    }
    try {
      const res = await commands.sshCreateTunnel(
        connectionId,
        tunnelType,
        parseInt(localPort, 10),
        remoteHost,
        parseInt(remotePort, 10)
      );
      if (res.status === "ok") {
        setShowCreate(false);
        setLocalPort("");
        setRemoteHost("");
        setRemotePort("");
        setConnectionId("");
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

  return (
    <div className="tunnel-panel">
      <div className="tunnel-header">
        <span className="tunnel-label">{t("ssh.tunnels.label")}</span>
        <Button variant="icon" onClick={() => setShowCreate(!showCreate)} title={t("ssh.tunnels.create")}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
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
                { value: "local", label: "Local" },
                { value: "remote", label: "Remote" },
                { value: "dynamic", label: "Dynamic" },
              ]}
            />
            <input className="input input-sm" placeholder="连接 ID" value={connectionId} onChange={(e) => setConnectionId(e.target.value)} style={{ flex: 1 }} />
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <input className="input input-sm" placeholder="本地端口" value={localPort} onChange={(e) => setLocalPort(e.target.value)} style={{ width: 100 }} />
            <input className="input input-sm" placeholder="远程地址" value={remoteHost} onChange={(e) => setRemoteHost(e.target.value)} style={{ flex: 1 }} />
            <input className="input input-sm" placeholder="远程端口" value={remotePort} onChange={(e) => setRemotePort(e.target.value)} style={{ width: 100 }} />
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button className="btn btn-primary btn-sm" onClick={handleCreate}>{t("ssh.tunnels.create")}</button>
            <button className="btn btn-secondary btn-sm" onClick={() => setShowCreate(false)}>取消</button>
          </div>
        </div>
      )}
      <div className="tunnel-list">
        {loading && <div className="empty-state compact">加载中…</div>}
        {!loading && tunnels.length === 0 && <div className="empty-state compact">{t("ssh.tunnels.empty")}</div>}
        {tunnels.map((tunnel) => (
          <div key={tunnel.id} className="tunnel-item">
            <div className="tunnel-item-main">
              <span className={`status-dot ${tunnel.status === "active" ? "online" : "offline"}`} />
              <span className={`tunnel-bind-badge ${tunnel.tunnelType}`}>{tunnel.tunnelType.toUpperCase()}</span>
              <span className="tunnel-endpoint">:{tunnel.localPort}</span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
              <span className="tunnel-endpoint">{tunnel.remoteHost}:{tunnel.remotePort}</span>
              <span className="text-muted text-xs" style={{ marginLeft: 8 }}>{tunnel.status}</span>
            </div>
            <button className="tunnel-delete-btn" onClick={() => handleClose(tunnel.id)} title={t("ssh.tunnels.delete")}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
