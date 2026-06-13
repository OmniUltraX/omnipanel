import { useWorkspaceStore } from "../../stores/workspaceStore";
import { WorkspacePanel } from "./WorkspacePanel";

/**
 * 底部工作区容器：仅挂载当前激活工作区，避免多实例 dockview 争抢拖放目标。
 */
export function WorkspaceBottomHost() {
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const currentId = useWorkspaceStore((state) => state.workspace.id);
  const current =
    workspaces.find((ws) => ws.id === currentId) ?? workspaces[0] ?? null;

  return (
    <div className="workspace-bottom-host">
      {current ? <WorkspacePanel workspace={current} /> : null}
    </div>
  );
}
