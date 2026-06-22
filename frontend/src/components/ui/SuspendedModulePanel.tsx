import { Suspense, type ReactNode } from "react";
import { ModuleVisibilityProvider } from "../../lib/moduleVisibility";
import { RouteModuleFallback } from "./RouteModuleFallback";

interface SuspendedModulePanelProps {
  active: boolean;
  /** 路由隐藏时是否 suspend（默认 true） */
  suspendWhenHidden?: boolean;
  children: ReactNode;
}

/** 路由级模块容器：lazy Suspense + 不可见时 suspend。 */
export function SuspendedModulePanel({
  active,
  suspendWhenHidden = true,
  children,
}: SuspendedModulePanelProps) {
  return (
    <ModuleVisibilityProvider active={active} suspended={suspendWhenHidden && !active}>
      <Suspense fallback={<RouteModuleFallback />}>{children}</Suspense>
    </ModuleVisibilityProvider>
  );
}
