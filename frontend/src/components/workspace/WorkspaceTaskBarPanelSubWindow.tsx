import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { SubWindow } from "../ui/window/SubWindow";
import {
  resolveWorkspaceTabPreview,
  stripWorkspaceTabCopySuffix,
} from "../../lib/workspaceTabPreview";
import type { WorkspaceDockTab } from "../../stores/workspaceBottomDockStore";
import { useWorkspaceBottomDockStore } from "../../stores/workspaceBottomDockStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { enterEngineeringWorkspaceFullscreen } from "../../lib/workspaceNavigation";
import { syncWorkspaceDockActiveTabSideEffects } from "../../lib/syncWorkspaceDockActiveTab";
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
  const navigate = useNavigate();

  const handleMaximizeToWorkspace = useCallback(() => {
    if (!tab) return;
    // 关闭弹窗
    onClose();
    // 进入全屏工作区
    const workspaceId = useWorkspaceStore.getState().workspace.id;
    enterEngineeringWorkspaceFullscreen(workspaceId, navigate);
    // 激活当前 tab
    const dockStore = useWorkspaceBottomDockStore.getState();
    dockStore.setActiveTabId(workspaceId, tab.id);
    syncWorkspaceDockActiveTabSideEffects(tab);
    window.dispatchEvent(
      new CustomEvent("omnipanel-workspace-dock-activate", {
        detail: { workspaceId, tabId: tab.id },
      }),
    );
  }, [tab, onClose, navigate]);

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
      onMaximizeToWorkspace={handleMaximizeToWorkspace}
    >
      <div className="workspace-taskbar-subwindow">
        <WorkspaceDockTabPanel tab={tab} isActive={open} />
      </div>
    </SubWindow>
  );
}

