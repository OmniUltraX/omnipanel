import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspaceStore, type WorkspaceInfo } from "../../stores/workspaceStore";
import { useBottomPanelStore } from "../../stores/bottomPanelStore";
import { isEmbeddedWorkspaceMode } from "../../lib/workspaceMode";
import { goWorkspaceHome, navigateToWorkspace } from "../../lib/workspaceNavigation";
import { useI18n } from "../../i18n";
import { WorkspacePopover } from "./WorkspacePopover";

const HALF_ICON_CLICK_DELAY_MS = 250;

interface WorkspaceSwitcherProps {
  /** 下拉展开方向；模块 Tab 栏使用 below，状态栏使用 above */
  placement?: "above" | "below";
  /** dock：模块 Tab 栏；statusbar：状态栏右侧 */
  variant?: "dock" | "statusbar";
  /** 半屏及以下为 false，隐藏首页入口 */
  showHome?: boolean;
  /** 任务栏紧凑模式 */
  compact?: boolean;
  className?: string;
  /** 自定义选择工作区行为；未提供时默认导航到 /workspace/:id */
  onSelectWorkspace?: (ws: WorkspaceInfo) => void;
}

function WorkspaceSwitcherIcon({ isHomeActive }: { isHomeActive: boolean }) {
  return (
    <svg
      className="workspace-switcher-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      width="14"
      height="14"
      aria-hidden
    >
      {isHomeActive ? (
        <path d="M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1V9.5z" />
      ) : (
        <>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M3 9h18" />
          <path d="M9 4v5" />
        </>
      )}
    </svg>
  );
}

/**
 * 工作区切换器：触发器显示当前上下文名称（首页 / 工程工作区名），下拉可切换。
 * 半屏 dock 模式：图标单击进工程全屏，双击进首页；名称区打开切换列表。
 */
export function WorkspaceSwitcher({
  placement = "below",
  variant = "dock",
  showHome = true,
  compact = false,
  className,
  onSelectWorkspace,
}: WorkspaceSwitcherProps) {
  const { t } = useI18n();
  const workspace = useWorkspaceStore((state) => state.workspace);
  const isHomeActive = useBottomPanelStore((state) => state.isHomeActive);
  const workspaceMode = useBottomPanelStore((state) => state.workspaceMode);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const halfIconClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isHalfDock = workspaceMode === "half" && variant === "dock";
  const displayLabel = isHomeActive ? t("shell.workspace.home") : workspace.name;

  /** 底部嵌入工作区（taskbar/缩略图/半屏）弹层向上展开，避免被屏幕底边裁切 */
  const popoverPlacement =
    isEmbeddedWorkspaceMode(workspaceMode) && workspaceMode !== "hidden"
      ? "above"
      : placement;

  const clearHalfIconClickTimer = useCallback(() => {
    if (halfIconClickTimerRef.current) {
      clearTimeout(halfIconClickTimerRef.current);
      halfIconClickTimerRef.current = null;
    }
  }, []);

  useEffect(() => () => clearHalfIconClickTimer(), [clearHalfIconClickTimer]);

  const togglePopover = useCallback(() => {
    setOpen((v) => !v);
  }, []);

  const handleHalfIconClick = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      event.preventDefault();
      clearHalfIconClickTimer();
      halfIconClickTimerRef.current = setTimeout(() => {
        halfIconClickTimerRef.current = null;
        navigateToWorkspace(workspace.id);
      }, HALF_ICON_CLICK_DELAY_MS);
    },
    [clearHalfIconClickTimer, workspace.id],
  );

  const handleHalfIconDoubleClick = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      event.preventDefault();
      clearHalfIconClickTimer();
      goWorkspaceHome();
    },
    [clearHalfIconClickTimer],
  );

  const rootClass = [
    "workspace-switcher",
    variant === "dock" ? "drag-ignore" : "",
    compact ? "workspace-switcher--compact" : "",
    isHomeActive ? "workspace-switcher--home" : "",
    isHalfDock ? "workspace-switcher--half-dock" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const popover = open ? (
    <WorkspacePopover
      anchorRef={buttonRef}
      placement={popoverPlacement}
      showHome={showHome}
      onClose={() => setOpen(false)}
      onSelectWorkspace={onSelectWorkspace}
    />
  ) : null;

  const halfIconTitle = `${t("shell.workspacePanel.fullscreen")} · ${t("shell.workspace.home")}`;

  if (variant === "statusbar") {
    return (
      <div className={rootClass}>
        <button
          ref={buttonRef}
          type="button"
          className={`statusbar-item statusbar-button${open ? " statusbar-button--active" : ""}`}
          onClick={togglePopover}
          aria-haspopup="dialog"
          aria-expanded={open}
          title={displayLabel}
        >
          <WorkspaceSwitcherIcon isHomeActive={isHomeActive} />
          <span className="statusbar-button-label">{displayLabel}</span>
          <svg
            className="statusbar-button-chevron"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            width="10"
            height="10"
            aria-hidden
          >
            <polyline points="6 15 12 9 18 15" />
          </svg>
        </button>
        {popover}
      </div>
    );
  }

  return (
    <div className={rootClass}>
      <button
        ref={buttonRef}
        type="button"
        className={`workspace-switcher-trigger${open ? " is-open" : ""}`}
        onClick={isHalfDock ? undefined : togglePopover}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={isHalfDock ? undefined : displayLabel}
      >
        {isHalfDock ? (
          <>
            <span
              className="workspace-switcher-icon-hit"
              role="presentation"
              title={halfIconTitle}
              onClick={handleHalfIconClick}
              onDoubleClick={handleHalfIconDoubleClick}
            >
              <WorkspaceSwitcherIcon isHomeActive={isHomeActive} />
            </span>
            <span
              className="workspace-switcher-menu-hit"
              role="presentation"
              onClick={(event) => {
                event.stopPropagation();
                togglePopover();
              }}
            >
              <span className="workspace-switcher-label">{displayLabel}</span>
              <svg
                className="workspace-switcher-chevron"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                width="10"
                height="10"
                aria-hidden
              >
                <polyline points="6 15 12 9 18 15" />
              </svg>
            </span>
          </>
        ) : (
          <>
            <WorkspaceSwitcherIcon isHomeActive={isHomeActive} />
            <span className="workspace-switcher-label">{displayLabel}</span>
            <svg
              className="workspace-switcher-chevron"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              width="10"
              height="10"
              aria-hidden
            >
              <polyline points="6 15 12 9 18 15" />
            </svg>
          </>
        )}
      </button>
      {popover}
    </div>
  );
}
