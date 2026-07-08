import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { SubWindow } from "../ui/window/SubWindow";
import { ModuleVisibilityProvider } from "../../lib/moduleVisibility";
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
  onMinimize: () => void;
  onRemove: (tabId: string) => void;
}

/** task-bar 模式：点击标签后在 SubWindow 中展示面板内容 */
export function WorkspaceTaskBarPanelSubWindow({
  tab,
  open,
  onMinimize,
  onRemove,
}: WorkspaceTaskBarPanelSubWindowProps) {
  const navigate = useNavigate();

  const handleMaximizeToWorkspace = useCallback(() => {
    if (!tab) return;
    const workspaceId = useWorkspaceStore.getState().workspace.id;
    // 先进入全屏并激活 tab，再关闭 SubWindow（taskbar 卸载后弹窗自然销毁）
    enterEngineeringWorkspaceFullscreen(workspaceId, navigate);
    const dockStore = useWorkspaceBottomDockStore.getState();
    dockStore.setActiveTabId(workspaceId, tab.id);
    syncWorkspaceDockActiveTabSideEffects(tab);
    onMinimize();
  }, [tab, onMinimize, navigate]);

  const handleClose = useCallback(() => {
    if (!tab) return;
    onRemove(tab.id);
  }, [onRemove, tab]);

  if (!tab) return null;

  const preview = resolveWorkspaceTabPreview(tab);
  const displayTitle = stripWorkspaceTabCopySuffix(preview.title);

  return (
    <SubWindow
      open={open}
      title={displayTitle}
      onClose={handleClose}
      className="workspace-taskbar-subwindow-panel"
      widthRatio={0.88}
      heightRatio={0.82}
      noOverlay
      onMinimize={onMinimize}
      onMaximizeToWorkspace={handleMaximizeToWorkspace}
    >
      <div className="workspace-taskbar-subwindow">
        <ModuleVisibilityProvider active suspended={false}>
          <WorkspaceDockTabPanel tab={tab} isActive={open} hostContext="taskbar-subwindow" />
        </ModuleVisibilityProvider>
      </div>
    </SubWindow>
  );
}

