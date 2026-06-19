import { useEffect } from "react";
import { useParams } from "react-router-dom";
import { useWorkspaceStore } from "../../stores/workspaceStore";

export function Dashboard() {
  const params = useParams<{ workspaceId: string }>();
  const switchWorkspace = useWorkspaceStore((state) => state.switchWorkspace);

  useEffect(() => {
    const id = params.workspaceId;
    if (id) switchWorkspace(id);
  }, [params.workspaceId, switchWorkspace]);

  return <div className="dashboard dashboard-home" />;
}
