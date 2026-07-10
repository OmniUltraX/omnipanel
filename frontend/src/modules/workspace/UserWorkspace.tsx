import { useLayoutEffect } from "react";
import { useParams } from "react-router-dom";
import { useWorkspaceStore } from "../../stores/workspaceStore";

/**
 * /workspace/:id 路由占位：同步当前工程工作区 ID。
 * 工程工作区 UI 统一由 WorkspaceBottomHost（嵌入/全屏）渲染。
 */
export function UserWorkspace() {
  const params = useParams<{ workspaceId: string }>();
  const switchWorkspace = useWorkspaceStore((state) => state.switchWorkspace);

  useLayoutEffect(() => {
    const id = params.workspaceId;
    if (!id) return;
    switchWorkspace(id);
  }, [params.workspaceId, switchWorkspace]);

  return null;
}
