import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useBottomPanelStore } from "../../stores/bottomPanelStore";
import { HomeWorkspacePanel } from "./HomeWorkspacePanel";
import { WorkspacePanel } from "./WorkspacePanel";

/**
 * 工作区容器：首页特殊工作区与工程工作区互斥挂载，避免 dockview 实例冲突。
 */
export function WorkspaceBottomHost() {
  const isHomeActive = useBottomPanelStore((state) => state.isHomeActive);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const currentId = useWorkspaceStore((state) => state.workspace.id);
  const current =
    workspaces.find((ws) => ws.id === currentId) ?? workspaces[0] ?? null;

  return (
    <div className="workspace-bottom-host">
      {isHomeActive ? (
        <HomeWorkspacePanel />
      ) : current ? (
        <WorkspacePanel workspace={current} />
      ) : null}
    </div>
  );
}
