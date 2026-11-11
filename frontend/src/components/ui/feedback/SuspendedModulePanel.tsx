import { Suspense, memo, useLayoutEffect, type ReactNode } from "react";
import { ModuleVisibilityProvider } from "../../../lib/moduleVisibility";
import { FrozenLocationWhenSuspended } from "./FrozenLocationWhenSuspended";
import { RouteModuleFallback } from "./RouteModuleFallback";
import {
  isOverlayVisuallyActive,
  markOverlayContentReady,
} from "../../../lib/overlayReveal";

interface SuspendedModulePanelProps {
  /** 为 true 时保持子树挂载（不 suspend） */
  active: boolean;
  /**
   * 对侧栏尺寸等可见性钩子：仅实际显示时为 true。
   * 默认与 active 相同；叠层「等新模块就绪再切换」时应传视觉可见性，
   * 避免隐藏面板按 0 宽同步侧栏。
   */
  visible?: boolean;
  /** 隐藏时是否 suspend（默认 true） */
  suspendWhenHidden?: boolean;
  /** 叠层面板 id（冻结 Location / 保活键） */
  panelId?: string;
  children: ReactNode;
}

function OverlayContentReadyMarker({ panelId }: { panelId: string }) {
  useLayoutEffect(() => {
    markOverlayContentReady(panelId);
  }, [panelId]);
  return null;
}

/**
 * 路由叠层模块容器：提供 ModuleVisibility，并用 Suspense 包住懒加载面板。
 * 隐藏时可 suspend，避免后台模块持续 IPC / 重渲染。
 */
export const SuspendedModulePanel = memo(function SuspendedModulePanel({
  active,
  visible,
  suspendWhenHidden = true,
  panelId = "module",
  children,
}: SuspendedModulePanelProps) {
  const suspended = suspendWhenHidden && !active;
  const visuallyActive = visible ?? active;
  const showFallback = isOverlayVisuallyActive(panelId) || panelId === "module";

  return (
    <ModuleVisibilityProvider active={visuallyActive} suspended={suspended}>
      <FrozenLocationWhenSuspended suspended={suspended} panelId={panelId}>
        <Suspense fallback={showFallback ? <RouteModuleFallback /> : null}>
          {panelId !== "module" ? <OverlayContentReadyMarker panelId={panelId} /> : null}
          {children}
        </Suspense>
      </FrozenLocationWhenSuspended>
    </ModuleVisibilityProvider>
  );
});
