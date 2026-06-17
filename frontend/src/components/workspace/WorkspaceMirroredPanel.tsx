import { useI18n } from "../../i18n";
import { TerminalTabDockPane } from "../../modules/terminal/TerminalTabDockPane";
import { DatabaseTabDockPane } from "../../modules/database/DatabaseTabDockPane";
import { DockerWorkspaceTabPane } from "../../modules/docker/DockerWorkspaceTabPane";
import type { WorkspaceDockTab } from "../../stores/workspaceBottomDockStore";

interface WorkspaceMirroredPanelProps {
  tab: WorkspaceDockTab;
  isActive: boolean;
}

/** 从其他模块拖入底部工作区后的镜像面板内容 */
export function WorkspaceMirroredPanel({ tab, isActive }: WorkspaceMirroredPanelProps) {
  const { t } = useI18n();

  if (tab.originScope === "terminal" && tab.originPanelId) {
    return (
      <div className="workspace-terminal-mirror">
        <TerminalTabDockPane
          tabId={tab.originPanelId}
          isActive={isActive}
        />
      </div>
    );
  }

  if (tab.originScope === "database" && tab.originPanelId) {
    return (
      <DatabaseTabDockPane tabId={tab.originPanelId} isActive={isActive} />
    );
  }

  if (tab.originScope === "docker" && tab.originPanelId) {
    const payload = tab.payload;
    if (payload?.module === "docker") {
      return <DockerWorkspaceTabPane snapshot={payload} isActive={isActive} />;
    }
  }

  return (
    <div className="workspace-mirror-placeholder">
      <p>{t("shell.workspacePanel.mirroredUnknown")}</p>
      <span className="workspace-mirror-placeholder__meta">{tab.label}</span>
    </div>
  );
}
