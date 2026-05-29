import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  type EnvironmentTag,
  type WorkspaceResource,
} from "../../lib/resourceRegistry";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useI18n } from "../../i18n";

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

export function HostListPanel({ resources, onConnect }: HostListPanelProps) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const selectedResourceByPath = useWorkspaceStore((s) => s.selectedResourceByPath);
  const selectResource = useWorkspaceStore((s) => s.selectResource);
  const setActivePath = useWorkspaceStore((s) => s.setActivePath);
  const activeHostId = selectedResourceByPath[SSH_PATH];

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

  return (
    <div className="host-list-panel">
      <div className="host-list-header">
        <h3>{t("ssh.sidebar.title")}</h3>
        <span className="badge badge-muted">{resources.length}</span>
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
                >
                  <button
                    type="button"
                    className="host-item"
                    onClick={() => selectHost(host)}
                    onDoubleClick={() => onConnect?.(host.id)}
                  >
                    <div className="host-icon">{HOST_ICON}</div>
                    <div className="host-info">
                      <div className="host-name">{host.name}</div>
                      <div className="host-addr">{host.subtitle}</div>
                    </div>
                    <span
                      className={`host-status ${host.status === "offline" ? "offline" : "online"}`}
                    />
                  </button>
                  {onConnect && (
                    <button
                      type="button"
                      className="host-connect-btn"
                      title={t("ssh.connect")}
                      onClick={() => onConnect(host.id)}
                    >
                      {t("ssh.connect")}
                    </button>
                  )}
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
