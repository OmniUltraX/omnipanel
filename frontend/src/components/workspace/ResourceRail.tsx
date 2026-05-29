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
  /** 自定义资源选择行为；未提供则跳转到资源所属模块 */
  onResourceSelect?: (resource: WorkspaceResource) => void;
}

export function ResourceRail({ title, resources, emptyText, onResourceSelect }: ResourceRailProps) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const activeResourceId = useWorkspaceStore((s) => s.activeResourceId);
  const selectResource = useWorkspaceStore((s) => s.selectResource);
  const setActivePath = useWorkspaceStore((s) => s.setActivePath);
  const resolvedEmpty = emptyText ?? t("common.noResources");

  const handleSelect = (resource: WorkspaceResource) => {
    if (onResourceSelect) {
      onResourceSelect(resource);
      return;
    }
    selectResource(resource.id, resource.modulePath);
    setActivePath(resource.modulePath);
    navigate(resource.modulePath);
  };

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
              onClick={() => handleSelect(resource)}
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
