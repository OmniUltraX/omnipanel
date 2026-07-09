import { useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { WorkspaceSwitcher } from "../shell/WorkspaceSwitcher";
import { WinControls } from "../shell/WinControls";
import { useI18n } from "../../i18n";
import type { WorkspaceInfo } from "../../stores/workspaceStore";
import { useBottomPanelStore, useEmbeddedWorkspaceMode } from "../../stores/bottomPanelStore";
import { shouldShowWorkspaceSwitcher } from "../../lib/workspaceMode";
import { toggleEngineeringWorkspaceFullscreen } from "../../lib/workspaceNavigation";
import { openWorkspaceWindow, dockWorkspaceWindowToMain } from "../../lib/workspaceWindow";
import { showToast } from "../../stores/toastStore";
import {
  resolveWorkspaceTabs,
  useWorkspaceBottomDockStore,
} from "../../stores/workspaceBottomDockStore";
import { WorkspaceDockCore } from "./WorkspaceDockCore";
import { WorkspaceDockEmpty } from "./WorkspaceDockEmpty";
import { WorkspaceFullscreenDragHandle } from "./WorkspaceFullscreenDragHandle";

interface WorkspacePanelProps {
  workspace: WorkspaceInfo;
  /** 独立 OS 窗口：布局等同工程工作区全屏，无弹出按钮 */
  detached?: boolean;
}

function workspaceDockScope(workspaceId: string): string {
  return `workspace-bottom-${workspaceId}`;
}

function WorkspaceModeStepControls({
  onStepUp,
  onStepDown,
  disableUp,
  disableDown,
  upTitle,
  downTitle,
}: {
  onStepUp: () => void;
  onStepDown: () => void;
  disableUp: boolean;
  disableDown: boolean;
  upTitle: string;
  downTitle: string;
}) {
  return (
    <>
      <button
        type="button"
        className="workspace-panel-mode-btn drag-ignore"
        title={upTitle}
        aria-label={upTitle}
        onClick={onStepUp}
        disabled={disableUp}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14" aria-hidden>
          <path d="M6 14l6-6 6 6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <button
        type="button"
        className="workspace-panel-mode-btn drag-ignore"
        title={downTitle}
        aria-label={downTitle}
        onClick={onStepDown}
        disabled={disableDown}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14" aria-hidden>
          <path d="M6 10l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </>
  );
}

export function WorkspacePanel({ workspace, detached = false }: WorkspacePanelProps) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const workspaceId = workspace.id;
  const dockScope = workspaceDockScope(workspaceId);
  const workspaceMode = useBottomPanelStore((state) => state.workspaceMode);
  const shiftWorkspaceModeUp = useBottomPanelStore((state) => state.shiftWorkspaceModeUp);
  const shiftWorkspaceModeDown = useBottomPanelStore((state) => state.shiftWorkspaceModeDown);
  const isEngineeringFullscreen = detached || workspaceMode === "fullscreen";
  const embeddedMode = useEmbeddedWorkspaceMode();
  const showWorkspaceSwitcher = shouldShowWorkspaceSwitcher({
    context: "embedded",
    workspaceMode,
    isFullscreen: isEngineeringFullscreen,
  });

  const workspaceSwitcherContext = isEngineeringFullscreen ? "bound" : "statusbar";

  const workspaceSwitcher = useMemo(
    () =>
      showWorkspaceSwitcher ? (
        <WorkspaceSwitcher
          placement="below"
          context={workspaceSwitcherContext}
          boundWorkspace={isEngineeringFullscreen ? workspace : undefined}
          showHomeOption={isEngineeringFullscreen}
        />
      ) : null,
    [isEngineeringFullscreen, showWorkspaceSwitcher, workspace, workspaceSwitcherContext],
  );

  const preActions = workspaceSwitcher;

  const rawTabs = useWorkspaceBottomDockStore(
    (state) => state.tabsByWorkspace[workspaceId],
  );

  const tabs = useMemo(
    () => resolveWorkspaceTabs(workspace, rawTabs),
    [workspace, rawTabs],
  );

  const handleTopbarDoubleClick = useCallback(
    (event: React.MouseEvent) => {
      const target = event.target as HTMLElement;
      const inHeader = target.closest(
        ".workspace-panel-empty-topbar, .dv-tabs-and-actions-container",
      );
      if (!inHeader) return;
      if (
        target.closest(
          ".workspace-switcher, .workspace-panel-fullscreen-btn, .workspace-panel-mode-btn, .dv-tab, .dv-default-tab, button, [role='button'], .drag-ignore",
        )
      ) {
        return;
      }
      toggleEngineeringWorkspaceFullscreen(navigate);
    },
    [navigate],
  );

  const handlePopOutWindow = useCallback(() => {
    void openWorkspaceWindow(workspaceId, workspace.name).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[workspacePanel] 弹出独立窗口失败", err);
      showToast(message || t("shell.workspacePanel.popOutWindowFailed"), 8000);
    });
  }, [workspaceId, workspace.name, t]);

  const handleDockBackToMain = useCallback(() => {
    void dockWorkspaceWindowToMain(workspaceId);
  }, [workspaceId]);

  const dockBackButton = useMemo(
    () => (
      <button
        type="button"
        className="workspace-panel-mode-btn drag-ignore"
        title={t("shell.workspacePanel.dockBackToMain")}
        aria-label={t("shell.workspacePanel.dockBackToMain")}
        onClick={handleDockBackToMain}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14" aria-hidden>
          <path d="M15 4h5v5" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M20 4L9 15" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M14 20H6a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2h8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    ),
    [handleDockBackToMain, t],
  );

  const popOutButton = useMemo(
    () => (
      <button
        type="button"
        className="workspace-panel-mode-btn drag-ignore"
        title={t("shell.workspacePanel.popOutWindow")}
        aria-label={t("shell.workspacePanel.popOutWindow")}
        onClick={handlePopOutWindow}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14" aria-hidden>
          <path d="M14 4h6v6" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M20 4l-8 8" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    ),
    [handlePopOutWindow, t],
  );

  const windowChromeLeftActions = useMemo(
    () => (
      <>
        {detached ? dockBackButton : popOutButton}
        {!isEngineeringFullscreen ? (
          <WorkspaceModeStepControls
            onStepUp={shiftWorkspaceModeUp}
            onStepDown={shiftWorkspaceModeDown}
            disableUp={isEngineeringFullscreen}
            disableDown={false}
            upTitle={t("shell.workspacePanel.modeUp")}
            downTitle={t("shell.workspacePanel.modeDown")}
          />
        ) : detached ? null : (
          <button
            type="button"
            className="workspace-panel-mode-btn drag-ignore"
            title={t("shell.workspacePanel.exitFullscreen")}
            aria-label={t("shell.workspacePanel.exitFullscreen")}
            onClick={() => toggleEngineeringWorkspaceFullscreen(navigate)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14" aria-hidden>
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
        )}
      </>
    ),
    [
      detached,
      dockBackButton,
      isEngineeringFullscreen,
      t,
      navigate,
      shiftWorkspaceModeUp,
      shiftWorkspaceModeDown,
      popOutButton,
    ],
  );

  const emptyContent = useMemo(
    () => <WorkspaceDockEmpty workspace={workspace} compact={!isEngineeringFullscreen} />,
    [workspace, isEngineeringFullscreen],
  );

  if (embeddedMode === "taskbar" && !isEngineeringFullscreen) {
    return null;
  }

  const isEmpty = tabs.length === 0;

  const frameClassName = [
    "workspace-panel-frame",
    isEngineeringFullscreen ? "workspace-panel-frame--engineering-full" : "",
    detached ? "workspace-panel-frame--detached" : "",
    isEmpty ? "workspace-panel--empty" : "",
  ]
    .filter(Boolean)
    .join(" ");

  // 空工作区时 dockview 空 group 的 tab 栏可能不渲染 header，
  // 导致 preActions(切换器) 和 rightHeaderActions(窗口按钮) 无处挂载。
  // 此时改用独立顶栏承载，确保切换器与窗口控制按钮始终可见。
  const emptyTopbar = isEmpty ? (
    <div className="workspace-panel-empty-topbar">
      {workspaceSwitcher}
      <div className="workspace-panel-empty-spacer" />
      {isEngineeringFullscreen ? (
        <>
          {windowChromeLeftActions}
          <WinControls />
        </>
      ) : (
        windowChromeLeftActions
      )}
    </div>
  ) : null;

  return (
    <div
      className={frameClassName}
      data-workspace-id={workspaceId}
      onDoubleClickCapture={handleTopbarDoubleClick}
    >
      {isEngineeringFullscreen && !detached ? <WorkspaceFullscreenDragHandle /> : null}
      {!isEngineeringFullscreen && !isEmpty ? (
        <div className="workspace-panel-mode-controls">
          {windowChromeLeftActions}
        </div>
      ) : null}
      {emptyTopbar}
      <WorkspaceDockCore
        workspace={workspace}
        dockScope={dockScope}
        preActions={isEmpty ? undefined : preActions}
        windowControl={isEngineeringFullscreen && !isEmpty}
        windowChromeLeftActions={
          isEngineeringFullscreen && !isEmpty ? windowChromeLeftActions : undefined
        }
        emptyContent={emptyContent}
      />
    </div>
  );
}
