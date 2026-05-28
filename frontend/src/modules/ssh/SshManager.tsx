import { useMemo, useState } from "react";
import { DockWorkspace } from "../../components/dock";
import { HostListPanel } from "../../components/workspace/HostListPanel";
import { workspaceResources, getResourceById } from "../../lib/resourceRegistry";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useActionStore } from "../../stores/actionStore";
import { useTopbarTabs } from "../../hooks/useTopbarTabs";
import { useI18n } from "../../i18n";

type ModuleTab = "hosts" | "tunnels" | "keys";
type DetailTab = "overview" | "terminal" | "sftp" | "tunnels" | "monitoring";

const MODULE_TABS: ModuleTab[] = ["hosts", "tunnels", "keys"];
const DETAIL_TABS: DetailTab[] = ["overview", "terminal", "sftp", "tunnels", "monitoring"];

export function SshManager() {
  const { t } = useI18n();
  const activeResourceId = useWorkspaceStore((s) => s.activeResourceId);
  const activeResource = getResourceById(activeResourceId);
  const enqueueAction = useActionStore((s) => s.enqueueAction);
  const actions = useActionStore((s) => s.actions);

  const [moduleTab, setModuleTab] = useState<ModuleTab>("hosts");
  const [detailTab, setDetailTab] = useState<DetailTab>("overview");

  const sshResources = useMemo(
    () => workspaceResources.filter((resource) => resource.type === "ssh"),
    []
  );

  const remoteActions = useMemo(
    () => actions.filter((action) => ["ssh", "terminal"].includes(action.type)).slice(0, 4),
    [actions]
  );

  const topbarTabs = useMemo(
    () =>
      MODULE_TABS.map((tab) => ({
        id: tab,
        label: t(`ssh.tabs.${tab}`),
        active: moduleTab === tab,
      })),
    [moduleTab, t]
  );

  useTopbarTabs(topbarTabs, {
    onSelect: (id) => setModuleTab(id as ModuleTab),
  }, { mode: "segment" });

  const hostDetail = moduleTab === "hosts" && (
    <div className="ssh-detail">
      <div className="ssh-detail-header">
        <div>
          <div className="host-title">{activeResource?.name ?? "prod-web-01"}</div>
          <div className="host-addr-detail">{activeResource?.subtitle ?? "deploy@192.168.1.100:22"}</div>
        </div>
        <span className="badge badge-success" style={{ marginLeft: "auto" }}>Online</span>
        <span className="badge badge-danger env-badge env-prod">{t("env.prod")}</span>
        <button
          className="btn btn-primary btn-sm"
          onClick={() =>
            enqueueAction({
              type: "ssh",
              title: t("ssh.actions.openSession"),
              description: t("ssh.actions.openSessionDesc"),
              resourceId: activeResource?.id ?? "prod-web-01",
              source: "用户",
            })
          }
        >
          {t("ssh.connect")}
        </button>
      </div>

      <div className="ssh-detail-tabs">
        {DETAIL_TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            className={`ssh-detail-tab${detailTab === tab ? " active" : ""}`}
            onClick={() => setDetailTab(tab)}
          >
            {t(`ssh.detailTabs.${tab}`)}
          </button>
        ))}
      </div>

      <div className="ssh-detail-body">
        {detailTab === "overview" && (
          <>
            <div className="quick-stats">
              <div className="quick-stat">
                <span className="stat-label">{t("ssh.overview.auth")}</span>
                <span className="stat-value">{t("ssh.overview.authValue")}</span>
              </div>
              <div className="quick-stat">
                <span className="stat-label">{t("ssh.overview.lastConnect")}</span>
                <span className="stat-value">{t("ssh.overview.lastConnectValue")}</span>
              </div>
              <div className="quick-stat">
                <span className="stat-label">{t("ssh.overview.policy")}</span>
                <span className="stat-value" style={{ fontSize: 14 }}>{t("ssh.overview.policyValue")}</span>
              </div>
              <div className="quick-stat">
                <span className="stat-label">{t("ssh.overview.context")}</span>
                <span className="stat-value" style={{ fontSize: 14 }}>{t("ssh.overview.contextValue")}</span>
              </div>
            </div>

            <section className="panel">
              <div className="panel-header">
                <h3>{t("ssh.capabilities.title")}</h3>
              </div>
              <div className="panel-body action-list">
                <button type="button" className="action-row">
                  <span className="action-title">{t("ssh.capabilities.terminal")}</span>
                  <span className="action-meta">{t("ssh.capabilities.terminalDesc")}</span>
                </button>
                <button type="button" className="action-row">
                  <span className="action-title">{t("ssh.capabilities.sftp")}</span>
                  <span className="action-meta">{t("ssh.capabilities.sftpDesc")}</span>
                </button>
                <button type="button" className="action-row">
                  <span className="action-title">{t("ssh.capabilities.tunnel")}</span>
                  <span className="action-meta">{t("ssh.capabilities.tunnelDesc")}</span>
                </button>
              </div>
            </section>
          </>
        )}
        {detailTab !== "overview" && (
          <div className="empty-state">
            <span>{t(`ssh.detailTabs.${detailTab}`)}</span>
            <span className="text-muted">{t("ssh.overview.contextValue")}</span>
          </div>
        )}
      </div>
    </div>
  );

  const tunnelsView = moduleTab === "tunnels" && (
    <div className="ssh-detail">
      <div className="panel">
        <div className="panel-header"><h3>{t("ssh.tabs.tunnels")}</h3></div>
        <div className="panel-body">
          <div className="feed-row">
            <span>localhost:5432 → prod-db-master:5432</span>
            <span className="badge badge-success">Active</span>
          </div>
          <div className="feed-row">
            <span>localhost:6379 → redis-cache:6379</span>
            <span className="badge badge-muted">Idle</span>
          </div>
        </div>
      </div>
    </div>
  );

  const keysView = moduleTab === "keys" && (
    <div className="ssh-detail">
      <div className="panel">
        <div className="panel-header"><h3>{t("ssh.tabs.keys")}</h3></div>
        <div className="panel-body action-list">
          <div className="action-row">
            <span className="action-title">id_ed25519</span>
            <span className="action-meta">ED25519 · Added 2025-12-01</span>
          </div>
          <div className="action-row">
            <span className="action-title">deploy_rsa</span>
            <span className="action-meta">RSA 4096 · Added 2024-08-15</span>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <DockWorkspace
      leftPreset="host"
      left={moduleTab === "hosts" ? <HostListPanel resources={sshResources} /> : undefined}
      main={hostDetail ?? tunnelsView ?? keysView}
      right={
        <div className="context-panel">
          <div className="panel-title">{t("ssh.context.title")}</div>
          <button
            className="btn btn-danger btn-sm"
            onClick={() =>
              enqueueAction({
                type: "terminal",
                title: t("ssh.actions.restartNginx"),
                description: t("ssh.actions.restartNginxDesc"),
                command: "sudo systemctl restart nginx",
                resourceId: activeResource?.id ?? "prod-web-01",
                source: "AI",
              })
            }
          >
            {t("ssh.context.restartConfirm")}
          </button>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() =>
              enqueueAction({
                type: "ssh",
                title: t("ssh.actions.testConnection"),
                description: t("ssh.actions.testConnectionDesc"),
                resourceId: activeResource?.id ?? "prod-web-01",
                source: "用户",
              })
            }
          >
            {t("ssh.context.testConnection")}
          </button>
        </div>
      }
      bottom={
        <div className="bottom-feed">
          <div className="panel-title">{t("ssh.feed.title")}</div>
          {remoteActions.map((action) => (
            <div key={action.id} className="feed-row">
              <span>{action.title}</span>
              <span>{action.status}</span>
            </div>
          ))}
        </div>
      }
    />
  );
}
