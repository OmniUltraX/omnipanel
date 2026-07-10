import { useCallback, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useWorkspaceStore, type WorkspaceInfo } from "../../stores/workspaceStore";
import { useBottomPanelStore } from "../../stores/bottomPanelStore";
import { isEmbeddedWorkspaceMode } from "../../lib/workspaceMode";
import { isDashboardPath } from "../../lib/paths";
import {
  selectWorkspaceForMainContext,
  selectWorkspaceFromBoundContext,
  selectWorkspaceUniversally,
} from "../../lib/workspaceNavigation";
import { useI18n } from "../../i18n";
import { WorkspacePopover } from "./WorkspacePopover";

interface WorkspaceSwitcherProps {
  /** 下拉展开方向；模块 Tab 栏使用 below，状态栏使用 above */
  placement?: "above" | "below";
  /** dock：模块 Tab 栏；statusbar：状态栏右侧 */
  variant?: "dock" | "statusbar";
  /**
   * home：首页顶栏，非独立窗工作区 → 进入工程工作区全屏；
   * statusbar：模块页右下角，仅切换当前工作区上下文；
   * bound：独立 OS 窗 / 全屏工程工作区面板，选择其他工作区不切换本窗。
   */
  context?: "home" | "statusbar" | "bound";
  /** 任务栏紧凑模式 */
  compact?: boolean;
  className?: string;
  /** 绑定的工作区（context=bound 时必填；决定左上角标签与下拉选中态） */
  boundWorkspace?: WorkspaceInfo;
  /** 自定义选择工作区行为；未提供时按 context 默认处理 */
  onSelectWorkspace?: (ws: WorkspaceInfo) => void;
  /** 覆盖是否在下拉中展示首页；默认 home 展示、bound/statusbar 不展示 */
  showHomeOption?: boolean;
}

function WorkspaceSwitcherIcon() {
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
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18" />
      <path d="M9 4v5" />
    </svg>
  );
}

/** 工作区切换器：点击打开下拉，选择工程工作区（或首页）。全屏切换由侧边栏 Logo 负责。 */
export function WorkspaceSwitcher({
  placement = "below",
  variant = "dock",
  context = "home",
  compact = false,
  className,
  boundWorkspace,
  onSelectWorkspace,
  showHomeOption: showHomeOptionProp,
}: WorkspaceSwitcherProps) {
  const { t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const storeWorkspace = useWorkspaceStore((state) => state.workspace);
  const workspaceMode = useBottomPanelStore((state) => state.workspaceMode);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const isBoundContext = context === "bound";
  const isHomeContext = context === "home";
  const displayWorkspace = boundWorkspace ?? storeWorkspace;
  const isBottomEmbedded =
    isEmbeddedWorkspaceMode(workspaceMode) && workspaceMode !== "hidden";
  const showHomeOption = showHomeOptionProp ?? isHomeContext;
  const isHomeRoute = isDashboardPath(location.pathname);
  const isHomeDisplay = isHomeRoute && isHomeContext;
  const displayLabel = isHomeDisplay
    ? t("shell.workspacePopover.home")
    : displayWorkspace.name;

  const handleHomeSelect = useCallback(
    (ws: WorkspaceInfo) => {
      void selectWorkspaceUniversally(ws.id, navigate);
    },
    [navigate],
  );

  const handleStatusbarSelect = useCallback(
    (ws: WorkspaceInfo) => {
      // 看板页底栏切换器与首页顶栏一致：进入全屏工程工作区或聚焦独立窗
      if (isDashboardPath(location.pathname)) {
        void selectWorkspaceUniversally(ws.id, navigate);
        return;
      }
      void selectWorkspaceForMainContext(ws.id, navigate);
    },
    [location.pathname, navigate],
  );

  const handleBoundSelect = useCallback(
    (ws: WorkspaceInfo) => {
      if (!boundWorkspace) return;
      void selectWorkspaceFromBoundContext(ws.id, boundWorkspace.id, navigate);
    },
    [boundWorkspace, navigate],
  );

  const resolvedSelectWorkspace =
    onSelectWorkspace ??
    (isBoundContext && boundWorkspace
      ? handleBoundSelect
      : context === "statusbar"
        ? handleStatusbarSelect
        : handleHomeSelect);

  /** 底部嵌入工作区（taskbar/缩略图/半屏）弹层向上展开，避免被屏幕底边裁切 */
  const popoverPlacement =
    isBoundContext && isBottomEmbedded ? "above" : placement;

  const togglePopover = useCallback(() => {
    setOpen((v) => !v);
  }, []);

  const rootClass = [
    "workspace-switcher",
    variant === "dock" ? "drag-ignore" : "",
    isHomeDisplay ? "workspace-switcher--home" : "",
    compact ? "workspace-switcher--compact" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const popover = open ? (
    <WorkspacePopover
      anchorRef={buttonRef}
      placement={popoverPlacement}
      onClose={() => setOpen(false)}
      onSelectWorkspace={resolvedSelectWorkspace}
      showHomeOption={showHomeOption}
      activeWorkspaceId={displayWorkspace.id}
    />
  ) : null;

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
          <WorkspaceSwitcherIcon />
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
        onClick={togglePopover}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={displayLabel}
      >
        <WorkspaceSwitcherIcon />
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
      </button>
      {popover}
    </div>
  );
}
