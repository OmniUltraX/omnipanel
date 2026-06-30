import { useCallback, useEffect, useMemo, useState } from "react";
import { commands } from "../../../../ipc/bindings";
import type { SshTunnelInfo } from "../../../../ipc/bindings";
import type { WorkspaceResource } from "../../../../lib/resourceRegistry";
import { useI18n } from "../../../../i18n";
import { Button } from "../../../../components/ui/Button";
import { Select } from "../../../../components/ui/Select";
import { TextInput } from "../../../../components/ui/TextInput";
import { TunnelFlowList } from "./TunnelFlowList";

type Props = {
  sshResources: WorkspaceResource[];
};

export function TunnelsModuleView({ sshResources }: Props) {
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

  const hostNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const resource of sshResources) {
      map.set(resource.id, resource.name);
    }
    return map;
  }, [sshResources]);

  const connectionOptions = useMemo(
    () =>
      sshResources.map((resource) => ({
        value: resource.id,
        label: resource.name,
      })),
    [sshResources],
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

  useEffect(() => {
    if (!connectionId && sshResources[0]) {
      setConnectionId(sshResources[0].id);
    }
  }, [connectionId, sshResources]);

  const handleCreate = async () => {
    if (!localPort || !remoteHost || !remotePort || !connectionId) {
      setError(t("ssh.tunnels.formRequired"));
      return;
    }
    try {
      const res = await commands.sshCreateTunnel(
        connectionId,
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

  return (
    <div className="ssh-detail">
      <div className="ssh-detail-header">
        <div>
          <div className="host-title">{t("ssh.tunnels.moduleTitle")}</div>
          <div className="host-addr-detail">{t("ssh.tunnels.moduleSubtitle")}</div>
        </div>
        <Button
          variant="primary"
          size="sm"
          style={{ marginLeft: "auto" }}
          onClick={() => setShowCreate((v) => !v)}
          disabled={sshResources.length === 0}
        >
          + {t("ssh.tunnels.create")}
        </Button>
      </div>

      {error && <div className="sftp-error">{error}</div>}

      {showCreate && (
        <div className="panel" style={{ margin: "0 24px 8px" }}>
          <div className="panel-header"><h3>{t("ssh.tunnels.create")}</h3></div>
          <div className="panel-body" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <Select
                className="input"
                value={tunnelType}
                onChange={(v) => setTunnelType(v as typeof tunnelType)}
                style={{ width: 120 }}
                searchable={false}
                options={[
                  { value: "local", label: t("ssh.tunnels.typeLocal") },
                  { value: "remote", label: t("ssh.tunnels.typeRemote") },
                  { value: "dynamic", label: t("ssh.tunnels.typeDynamic") },
                ]}
              />
              <Select
                className="input"
                value={connectionId}
                onChange={setConnectionId}
                style={{ flex: 1 }}
                searchable
                options={connectionOptions}
                placeholder={t("ssh.tunnels.selectHost")}
              />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <TextInput
                placeholder={t("ssh.tunnels.localPort")}
                value={localPort}
                onChange={setLocalPort}
                style={{ width: 120 }}
              />
              <TextInput
                placeholder={t("ssh.tunnels.remoteHost")}
                value={remoteHost}
                onChange={setRemoteHost}
                style={{ flex: 1 }}
              />
              <TextInput
                placeholder={t("ssh.tunnels.remotePort")}
                value={remotePort}
                onChange={setRemotePort}
                style={{ width: 120 }}
              />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-primary btn-sm" onClick={handleCreate}>
                {t("ssh.tunnels.create")}
              </button>
              <button className="btn btn-secondary btn-sm" onClick={() => setShowCreate(false)}>
                {t("ssh.keys.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="ssh-detail-body ssh-workbench-grid">
        <div className="panel">
          <div className="panel-header">
            <h3>{t("ssh.tunnels.allTitle")}</h3>
          </div>
          <div className="panel-body">
            {loading && <div className="text-muted text-sm" style={{ padding: 12 }}>{t("ssh.keys.loading")}</div>}
            {!loading && tunnels.length === 0 && (
              <div className="text-muted text-sm" style={{ padding: 12 }}>{t("ssh.tunnels.empty")}</div>
            )}
            {!loading && tunnels.length > 0 && (
              <TunnelFlowList
                tunnels={tunnels}
                hostNameById={hostNameById}
                onClose={(id) => void handleClose(id)}
              />
            )}
          </div>
        </div>
        <div className="ssh-side-stack">
          <div className="panel">
            <div className="panel-header">
              <h3>{t("ssh.tunnels.tipsTitle")}</h3>
            </div>
            <div className="panel-body action-list">
              <div className="action-row">
                <span className="action-title">{t("ssh.tunnels.tipDbTitle")}</span>
                <span className="action-meta">{t("ssh.tunnels.tipDbDesc")}</span>
              </div>
              <div className="action-row">
                <span className="action-title">{t("ssh.tunnels.tipServiceTitle")}</span>
                <span className="action-meta">{t("ssh.tunnels.tipServiceDesc")}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
