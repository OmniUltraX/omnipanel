import { useNavigate } from "react-router-dom";
import {
  type WorkspaceResource,
  type EnvironmentTag,
  type ResourceType,
} from "../../lib/resourceRegistry";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useI18n } from "../../i18n";

interface ResourceRailProps {
  title: string;
  resources: WorkspaceResource[];
  emptyText?: string;
}

export function ResourceRail({ title, resources, emptyText }: ResourceRailProps) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const activeResourceId = useWorkspaceStore((s) => s.activeResourceId);
  const selectResource = useWorkspaceStore((s) => s.selectResource);
  const setActivePath = useWorkspaceStore((s) => s.setActivePath);
  const resolvedEmpty = emptyText ?? t("common.noResources");

  return (
    <div className="resource-rail">
      <div className="resource-rail-header">
        <span>{title}</span>
        <span className="badge badge-muted">{resources.length}</span>
      </div>
      <div className="resource-list">
        {resources.length === 0 ? (
          <div className="empty-state compact">{resolvedEmpty}</div>
        ) : (
          resources.map((resource) => (
            <button
              key={resource.id}
              type="button"
              className={`resource-item${activeResourceId === resource.id ? " active" : ""}`}
              onClick={() => {
                selectResource(resource.id);
                setActivePath(resource.modulePath);
                navigate(resource.modulePath);
              }}
            >
              <span className={`resource-status status-${resource.status}`} />
              <span className="resource-body">
                <span className="resource-name">{resource.name}</span>
                <span className="resource-subtitle">{resource.subtitle}</span>
                <span className="resource-meta">
                  {t(`resourceType.${resource.type as ResourceType}`)} ·{" "}
                  {t(`env.${resource.environment as EnvironmentTag}`)}
                </span>
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
