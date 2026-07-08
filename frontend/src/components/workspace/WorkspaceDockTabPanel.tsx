import type { WorkspaceDockTab } from "../../stores/workspaceBottomDockStore";
import { WorkspaceMirroredPanel } from "./WorkspaceMirroredPanel";
import { WorkspacePayloadPanel } from "./WorkspacePayloadPanel";

export type WorkspaceDockTabHostContext = "taskbar-subwindow" | "workspace-dock";

interface WorkspaceDockTabPanelProps {
  tab: WorkspaceDockTab;
  isActive: boolean;
  hostContext?: WorkspaceDockTabHostContext;
}

/** 单个工作区 Tab 的面板内容（dockview / SubWindow 共用） */
export function WorkspaceDockTabPanel({
  tab,
  isActive,
  hostContext = "workspace-dock",
}: WorkspaceDockTabPanelProps) {
  if (tab.kind === "payload" && tab.payload) {
    return <WorkspacePayloadPanel tab={tab} isActive={isActive} />;
  }
  return (
    <WorkspaceMirroredPanel tab={tab} isActive={isActive} hostContext={hostContext} />
  );
}
