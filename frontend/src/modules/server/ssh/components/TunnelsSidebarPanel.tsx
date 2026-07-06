import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { commands } from "../../../../ipc/bindings";
import type { SshTunnelInfo } from "../../../../ipc/bindings";
import type { WorkspaceResource } from "../../../../lib/resourceRegistry";
import { useI18n } from "../../../../i18n";
import { Select } from "../../../../components/ui/Select";
import { TextInput } from "../../../../components/ui/TextInput";
import { useSshWorkspaceNavStore } from "../stores/sshWorkspaceNavStore";
import { SshSidebarHeaderIconBtn } from "./SshSidebarModal";

type Props = {
  sshResources: WorkspaceResource[];
  onCountChange?: (count: number) => void;
  onHeaderMetaChange?: (meta: { count: number; actions: ReactNode }) => void;
  onEnsureExpanded?: () => void;
};

export function TunnelsSidebarPanel({
  sshResources,
  onCountChange,
  onHeaderMetaChange,
  onEnsureExpanded,
}: Props) {
  const { t } = useI18n();
  const [tunnels, setTunnels] = useState<SshTunnelInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [tunnelType, setTunnelType] = useState<"local" | "remote" | "dynamic">("local");
  const [localPort, setLocalPort] = useState("");
  const [remoteHost, setRemoteHost] = useState("");
  const [remotePort, setRemotePort] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [closingId, setClosingId] = useState<string | null>(null);
  const activeTunnelId = useSshWorkspaceNavStore((s) => s.activeTunnelId);
  const selectTunnel = useSshWorkspaceNavStore((s) => s.selectTunnel);

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
    void loadTunnels();
  }, [loadTunnels]);

  useEffect(() => {
    onCountChange?.(tunnels.length);
  }, [onCountChange, tunnels.length]);

  useEffect(() => {
    if (!connectionId && sshResources[0]) {
      setConnectionId(sshResources[0].id);
    }
  }, [connectionId, sshResources]);

  const toggleCreate = useCallback(() => {
    onEnsureExpanded?.();
    setShowCreate((v) => !v);
    setError(null);
  }, [onEnsureExpanded]);

  const headerToolbar = useMemo(
    () => (
      <div className="schema-toolbar schema-toolbar--inline">
        <SshSidebarHeaderIconBtn
          title={t("common.refresh")}
          disabled={loading}
          onClick={() => void loadTunnels()}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
            <path d="M23 4v6h-6M1 20v-6h6" />
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
          </svg>
        </SshSidebarHeaderIconBtn>
        <SshSidebarHeaderIconBtn
          title={t("ssh.tunnels.create")}
          active={showCreate}
          disabled={sshResources.length === 0}
          onClick={toggleCreate}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </SshSidebarHeaderIconBtn>
      </div>
    ),
    [loadTunnels, loading, showCreate, sshResources.length, t, toggleCreate],
  );

  useLayoutEffect(() => {
    onHeaderMetaChange?.({ count: tunnels.length, actions: headerToolbar });
  }, [headerToolbar, onHeaderMetaChange, tunnels.length]);

  const handleCreate = async () => {
    if (!localPort || !remoteHost || !remotePort || !connectionId) {
      setError(t("ssh.tunnels.formRequired"));
      return;
    }
    const local = parseInt(localPort, 10);
    const remote = parseInt(remotePort, 10);
    if (!Number.isFinite(local) || !Number.isFinite(remote)) {
      setError(t("ssh.tunnels.formRequired"));
      return;
    }
    try {
      const res = await commands.sshCreateTunnel(
        connectionId,
        tunnelType,
        local,
        remoteHost,
        remote,
      );
      if (res.status === "ok") {
        setShowCreate(false);
        setLocalPort("");
        setRemoteHost("");
        setRemotePort("");
        void loadTunnels();
      } else {
        setError(res.error.message);
      }
    } catch (e) {
      setError(String(e));
    }
  };

  const handleClose = async (tunnelId: string) => {
    setClosingId(tunnelId);
    setError(null);
    try {
      const res = await commands.sshCloseTunnel(tunnelId);
      if (res.status === "ok") {
        if (activeTunnelId === tunnelId) {
          selectTunnel(null);
        }
        void loadTunnels();
      } else {
        setError(res.error.message);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setClosingId(null);
    }
  };

  return (
    <div className="ssh-sidebar-list-panel">
      {error ? <div className="ssh-sidebar-list-panel__error">{error}</div> : null}

      {showCreate ? (
        <div className="ssh-sidebar-form">
          <Select
            className="input input-sm"
            value={tunnelType}
            onChange={(v) => setTunnelType(v as typeof tunnelType)}
            searchable={false}
            options={[
              { value: "local", label: t("ssh.tunnels.typeLocal") },
              { value: "remote", label: t("ssh.tunnels.typeRemote") },
              { value: "dynamic", label: t("ssh.tunnels.typeDynamic") },
            ]}
          />
          <Select
            className="input input-sm"
            value={connectionId}
            onChange={setConnectionId}
            searchable
            options={connectionOptions}
            placeholder={t("ssh.tunnels.selectHost")}
          />
          <TextInput
            size="sm"
            placeholder={t("ssh.tunnels.localPort")}
            value={localPort}
            onChange={setLocalPort}
          />
          <TextInput
            size="sm"
            placeholder={t("ssh.tunnels.remoteHost")}
            value={remoteHost}
            onChange={setRemoteHost}
          />
          <TextInput
            size="sm"
            placeholder={t("ssh.tunnels.remotePort")}
            value={remotePort}
            onChange={setRemotePort}
          />
          <div className="ssh-sidebar-form__actions">
            <button type="button" className="btn btn-primary btn-xs" onClick={() => void handleCreate()}>
              {t("ssh.tunnels.create")}
            </button>
            <button type="button" className="btn btn-secondary btn-xs" onClick={() => setShowCreate(false)}>
              {t("ssh.keys.cancel")}
            </button>
          </div>
        </div>
      ) : null}

      {loading && tunnels.length === 0 ? (
        <div className="ssh-sidebar-list-panel__empty">{t("ssh.keys.loading")}</div>
      ) : tunnels.length === 0 ? (
        <div className="ssh-sidebar-list-panel__empty">{t("ssh.tunnels.empty")}</div>
      ) : (
        <ul className="ssh-sidebar-list">
          {tunnels.map((tunnel) => {
            const hostName = hostNameById.get(tunnel.connectionId) ?? tunnel.connectionId;
            const label = `${tunnel.localPort} → ${tunnel.remoteHost}:${tunnel.remotePort}`;
            const active = tunnel.status === "active" || tunnel.status === "running";
            const selected = activeTunnelId === tunnel.id;
            return (
              <li
                key={tunnel.id}
                className={`ssh-sidebar-list__row${selected ? " ssh-sidebar-list__row--active" : ""}`}
              >
                <button
                  type="button"
                  className="ssh-sidebar-list__item"
                  onClick={() => selectTunnel(tunnel.id)}
                >
                  <span className="ssh-sidebar-list__name">{label}</span>
                  <span className="ssh-sidebar-list__meta">
                    <span>{hostName}</span>
                  </span>
                </button>
                <div className="ssh-sidebar-list__aside">
                  <span
                    className={`ssh-sidebar-list__preview-idle ssh-sidebar-list__status ssh-sidebar-list__status--${active ? "on" : "off"}`}
                  >
                    {active ? t("ssh.tunnels.active") : t("ssh.tunnels.closed")}
                  </span>
                  <div className="ssh-sidebar-list__aside-hover">
                    <div className="ssh-sidebar-list__row-actions">
                      <button
                        type="button"
                        className="ssh-sidebar-list__action-btn ssh-sidebar-list__action-btn--danger"
                        disabled={closingId === tunnel.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleClose(tunnel.id);
                        }}
                      >
                        {t("ssh.tunnels.delete")}
                      </button>
                    </div>
                    <span className="ssh-sidebar-list__preview">
                      {tunnel.tunnelType.toUpperCase()} · {hostName}
                    </span>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
