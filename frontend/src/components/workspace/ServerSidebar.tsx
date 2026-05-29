import { useMemo } from "react";
import {
  type EnvironmentTag,
  type WorkspaceResource,
} from "../../lib/resourceRegistry";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useI18n } from "../../i18n";

const SERVER_PATH = "/server";

interface ServerSidebarProps {
  resources: WorkspaceResource[];
}

function statusDotClass(status: WorkspaceResource["status"]) {
  if (status === "warning") return "warning";
  if (status === "offline") return "offline";
  return "online";
}

export function ServerSidebar({ resources }: ServerSidebarProps) {
  const { t } = useI18n();
  const selectedResourceByPath = useWorkspaceStore((s) => s.selectedResourceByPath);
  const selectResource = useWorkspaceStore((s) => s.selectResource);
  const activeServerId = selectedResourceByPath[SERVER_PATH];

  const grouped = useMemo(() => {
    const order: EnvironmentTag[] = ["prod", "staging", "dev", "local", "unknown"];
    return order
      .map((env) => ({
        env,
        label: t(`env.${env}`),
        items: resources.filter((r) => r.environment === env),
      }))
      .filter((g) => g.items.length > 0);
  }, [resources, t]);

  const selectServer = (resource: WorkspaceResource) => {
    selectResource(resource.id, SERVER_PATH);
  };

  return (
    <div className="server-sidebar">
      <div className="server-sidebar-header">
        <span>{t("server.sidebar.title")}</span>
        <span className="badge badge-muted">{resources.length}</span>
      </div>
      {grouped.length === 0 ? (
        <div className="empty-state compact">{t("common.noResources")}</div>
      ) : (
        grouped.map((group) => (
          <div key={group.env} className="server-group">
            <div className="server-group-title">{group.label}</div>
            {group.items.map((server) => (
              <button
                key={server.id}
                type="button"
                className={`server-item${activeServerId === server.id ? " active" : ""}`}
                onClick={() => selectServer(server)}
              >
                <span className={`status-dot ${statusDotClass(server.status)}`} />
                <span className="server-name">{server.name}</span>
                <span className={`env-tag env-${server.environment}`}>
                  {t(`env.${server.environment}`)}
                </span>
              </button>
            ))}
          </div>
        ))
      )}
    </div>
  );
}
