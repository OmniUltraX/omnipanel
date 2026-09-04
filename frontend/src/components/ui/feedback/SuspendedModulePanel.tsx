import { Suspense, memo, type ReactNode } from "react";
import { ModuleVisibilityProvider } from "../../../lib/moduleVisibility";
import { FrozenLocationWhenSuspended } from "./FrozenLocationWhenSuspended";
import { RouteModuleFallback } from "./RouteModuleFallback";

interface SuspendedModulePanelProps {
  active: boolean;
  /** 隐藏时是否 suspend（默认 true） */
  suspendWhenHidden?: boolean;
  /** 叠层面板 id（冻结 Location / 保活键） */
  panelId?: string;
  children: ReactNode;
}

/**
 * 路由叠层模块容器：提供 ModuleVisibility，并用 Suspense 包住懒加载面板。
 * 隐藏时可 suspend，避免后台模块持续 IPC / 重渲染。
 */
export const SuspendedModulePanel = memo(function SuspendedModulePanel({
  active,
  suspendWhenHidden = true,
  panelId = "module",
  children,
}: SuspendedModulePanelProps) {
  const suspended = suspendWhenHidden && !active;

  return (
    <ModuleVisibilityProvider active={active} suspended={suspended}>
      <FrozenLocationWhenSuspended suspended={suspended} panelId={panelId}>
        <Suspense fallback={<RouteModuleFallback />}>{children}</Suspense>
      </FrozenLocationWhenSuspended>
    </ModuleVisibilityProvider>
  );
});
