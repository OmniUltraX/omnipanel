import { useCallback, useEffect, useMemo, useState } from "react";
import { commands } from "../../ipc/bindings";
import type { SshTunnelInfo } from "../../ipc/bindings";
import type { WorkspaceResource } from "../../lib/resourceRegistry";
import { useI18n } from "../../i18n";
import { Button } from "../ui/Button";
import { Select } from "../ui/Select";
import { TextInput } from "../ui/TextInput";
import { TunnelFlowList } from "../../modules/server/ssh/components/TunnelFlowList";

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
            <TextInput
              size="sm"
              placeholder={t("ssh.tunnels.localPort")}
              value={localPort}
              onChange={setLocalPort}
              style={{ width: 100 }}
            />
            <TextInput
              size="sm"
              placeholder={t("ssh.tunnels.remoteHost")}
              value={remoteHost}
              onChange={setRemoteHost}
              style={{ flex: 1 }}
            />
            <TextInput
              size="sm"
              placeholder={t("ssh.tunnels.remotePort")}
              value={remotePort}
              onChange={setRemotePort}
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
        {!loading && hostTunnels.length > 0 && (
          <TunnelFlowList
            tunnels={hostTunnels}
            onClose={(id) => void handleClose(id)}
            compact
          />
        )}
      </div>
    </div>
  );
}
