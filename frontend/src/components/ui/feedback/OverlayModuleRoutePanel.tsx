import { memo, type ReactNode } from "react";
import { SuspendedModulePanel } from "./SuspendedModulePanel";

interface OverlayModuleRoutePanelProps {
  active: boolean;
  /** 首次访问前不挂载（lazy） */
  mounted?: boolean;
  suspendWhenHidden?: boolean;
  /**
   * 含 dockview 等依赖实时尺寸测量的模块需置 true：隐藏时仍保留子树布局，
   * 不参与 content-visibility:hidden 优化，避免量到 0 宽后 api.layout 压扁。
   */
  keepLayout?: boolean;
  /** 叠层面板 id（冻结 Location） */
  panelId?: string;
  children: ReactNode;
}

/**
 * dock 模块叠层路由：始终 absolute 铺满，仅切 visibility。
 * memo：路由切换时 active/mounted 未变的模块整树跳过重渲（需配合稳定 children 引用）。
 */
export const OverlayModuleRoutePanel = memo(function OverlayModuleRoutePanel({
  active,
  mounted = true,
  suspendWhenHidden = true,
  keepLayout = false,
  panelId,
  children,
}: OverlayModuleRoutePanelProps) {
  if (!mounted) return null;

  const className = [
    "route-panel route-panel--overlay",
    active ? "route-panel--active" : "",
    keepLayout ? "route-panel--keep-layout" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={className}>
      <SuspendedModulePanel
        active={active}
        suspendWhenHidden={suspendWhenHidden}
        panelId={panelId}
      >
        {children}
      </SuspendedModulePanel>
    </div>
  );
});
