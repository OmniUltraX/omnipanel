import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { asArray } from "../../../../ipc/asArray";
import { commands } from "../../../../ipc/bindings";
import type { SshTunnelInfo } from "../../../../ipc/bindings";
import type { WorkspaceResource } from "../../../../lib/resourceRegistry";
import { useI18n } from "../../../../i18n";
import { Select } from "../../../../components/ui/Select";
import { TextInput } from "../../../../components/ui/TextInput";
import { useSshWorkspaceNavStore } from "../stores/sshWorkspaceNavStore";
import { SshSidebarHeaderIconBtn } from "./SshSidebarModal";
import { SidebarIcon, SidebarRefreshIcon, SidebarStatusDot } from "../../../../components/ui/module-sidebar";
import { SidebarTreeEmpty, SidebarTreeNode, SidebarTreeRoot } from "../../../../components/ui/sidebar-tree";
import { WorkbenchActionButton } from "../../../../components/ui/primitives/WorkbenchActionButton";

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
        setTunnels(asArray(res.data));
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
          <SidebarRefreshIcon />
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
            <WorkbenchActionButton type="button" onClick={() => void handleCreate()}>
              {t("ssh.tunnels.create")}
            </WorkbenchActionButton>
            <WorkbenchActionButton type="button" onClick={() => setShowCreate(false)}>
              {t("ssh.keys.cancel")}
            </WorkbenchActionButton>
          </div>
        </div>
      ) : null}

      {loading && tunnels.length === 0 ? (
        <SidebarTreeEmpty>{t("ssh.keys.loading")}</SidebarTreeEmpty>
      ) : tunnels.length === 0 ? (
        <SidebarTreeEmpty>{t("ssh.tunnels.empty")}</SidebarTreeEmpty>
      ) : (
        <SidebarTreeRoot className="ssh-sidebar-tree">
          {tunnels.map((tunnel) => {
            const hostName = hostNameById.get(tunnel.connectionId) ?? tunnel.connectionId;
            const label = `${tunnel.localPort} → ${tunnel.remoteHost}:${tunnel.remotePort}`;
            const running = tunnel.status === "active" || tunnel.status === "running";
            const selected = activeTunnelId === tunnel.id;
            const statusLabel = running ? t("ssh.tunnels.active") : t("ssh.tunnels.closed");
            return (
              <SidebarTreeNode
                key={tunnel.id}
                module="ssh"
                nodeType="tunnel"
                depth={0}
                treeKey={tunnel.id}
                expanded={false}
                hasChildren={false}
                active={selected}
                icon={<SidebarIcon kind="tunnel" />}
                prefix={
                  <SidebarStatusDot
                    status={running ? "online" : "idle"}
                    title={statusLabel}
                  />
                }
                label={label}
                note={hostName}
                trailing={
                  <>
                    <span className="sidebar-tag-chip">{tunnel.tunnelType.toUpperCase()}</span>
                    <span className="sidebar-tag-chip">{statusLabel}</span>
                    <div className="tree-node-actions">
                      <button
                        type="button"
                        className="tree-action-btn tree-action-btn--danger"
                        title={t("ssh.tunnels.delete")}
                        aria-label={t("ssh.tunnels.delete")}
                        disabled={closingId === tunnel.id}
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleClose(tunnel.id);
                        }}
                      >
                        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
                          <path d="M4 4l8 8M12 4l-8 8" />
                        </svg>
                      </button>
                    </div>
                  </>
                }
                onToggle={() => {}}
                onSelect={() => selectTunnel(tunnel.id)}
              />
            );
          })}
        </SidebarTreeRoot>
      )}
    </div>
  );
}
