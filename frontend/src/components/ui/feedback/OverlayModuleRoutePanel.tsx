import { memo, useSyncExternalStore, type ReactNode } from "react";
import { SuspendedModulePanel } from "./SuspendedModulePanel";
import {
  isOverlayVisuallyActive,
  subscribeOverlayReveal,
} from "../../../lib/overlayReveal";

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
 *
 * visibility 以 overlayReveal 的 visualActive 为准：新模块未就绪时继续显示上一个，
 * 避免内容区闪「加载中…」或启动闪屏。
 */
export const OverlayModuleRoutePanel = memo(function OverlayModuleRoutePanel({
  active,
  mounted = true,
  suspendWhenHidden = true,
  keepLayout = false,
  panelId,
  children,
}: OverlayModuleRoutePanelProps) {
  const id = panelId ?? "module";
  const visualActive = useSyncExternalStore(
    subscribeOverlayReveal,
    () => isOverlayVisuallyActive(id),
    () => isOverlayVisuallyActive(id),
  );
  if (!mounted) return null;

  const className = [
    "route-panel route-panel--overlay",
    visualActive ? "route-panel--active" : "",
    keepLayout ? "route-panel--keep-layout" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={className}>
      <SuspendedModulePanel
        active={active || visualActive}
        visible={visualActive}
        suspendWhenHidden={suspendWhenHidden}
        panelId={panelId}
      >
        {children}
      </SuspendedModulePanel>
    </div>
  );
});
