import { WorkspaceSwitcher } from "../shell/WorkspaceSwitcher";
import { useBottomPanelStore } from "../../stores/bottomPanelStore";
import { useI18n } from "../../i18n";

interface WorkspaceCompactFloatingChromeProps {
  /** 任务栏单行布局时 switcher 使用紧凑样式 */
  compactSwitcher?: boolean;
}

/** 缩略图 / 任务栏模式：左上角切换器 + 右上角全屏，悬浮于内容之上 */
export function WorkspaceCompactFloatingChrome({
  compactSwitcher = false,
}: WorkspaceCompactFloatingChromeProps) {
  const { t } = useI18n();
  const handleWorkspaceChromeIcon = useBottomPanelStore(
    (state) => state.handleWorkspaceChromeIcon,
  );

  return (
    <>
      <div className="workspace-compact-float workspace-compact-float--left drag-ignore">
        <WorkspaceSwitcher
          placement="below"
          showHome={false}
          compact={compactSwitcher}
        />
      </div>
      <button
        type="button"
        className="workspace-compact-float-btn workspace-compact-float workspace-compact-float--right drag-ignore"
        title={t("shell.workspacePanel.fullscreen")}
        aria-label={t("shell.workspacePanel.fullscreen")}
        onClick={handleWorkspaceChromeIcon}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          width="14"
          height="14"
          aria-hidden
        >
          <path d="M8 3H5a2 2 0 00-2 2v3" />
          <path d="M16 3h3a2 2 0 012 2v3" />
          <path d="M8 21H5a2 2 0 01-2-2v-3" />
          <path d="M16 21h3a2 2 0 002-2v-3" />
        </svg>
      </button>
    </>
  );
}
