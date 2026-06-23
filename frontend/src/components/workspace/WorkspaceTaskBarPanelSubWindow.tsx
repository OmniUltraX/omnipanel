import { SubWindow } from "../ui/SubWindow";
import {
  resolveWorkspaceTabPreview,
  stripWorkspaceTabCopySuffix,
} from "../../lib/workspaceTabPreview";
import type { WorkspaceDockTab } from "../../stores/workspaceBottomDockStore";
import { WorkspaceDockTabPanel } from "./WorkspaceDockTabPanel";

interface WorkspaceTaskBarPanelSubWindowProps {
  tab: WorkspaceDockTab | null;
  open: boolean;
  onClose: () => void;
}

/** task-bar 模式：点击标签后在 SubWindow 中展示面板内容 */
export function WorkspaceTaskBarPanelSubWindow({
  tab,
  open,
  onClose,
}: WorkspaceTaskBarPanelSubWindowProps) {
  if (!tab) return null;

  const preview = resolveWorkspaceTabPreview(tab);
  const displayTitle = stripWorkspaceTabCopySuffix(preview.title);

  return (
    <SubWindow
      open={open}
      title={displayTitle}
      onClose={onClose}
      className="workspace-taskbar-subwindow-panel"
      widthRatio={0.88}
      heightRatio={0.82}
      noOverlay
      onMinimize={onClose}
    >
      <div className="workspace-taskbar-subwindow">
        <WorkspaceDockTabPanel tab={tab} isActive={open} />
      </div>
    </SubWindow>
  );
}
