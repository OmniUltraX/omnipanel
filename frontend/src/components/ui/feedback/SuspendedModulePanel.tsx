import { Suspense, type ReactNode } from "react";
import { ModuleVisibilityProvider } from "../../../lib/moduleVisibility";
import { RouteModuleFallback } from "./RouteModuleFallback";

interface SuspendedModulePanelProps {
  active: boolean;
  /** ??????? suspend??? true? */
  suspendWhenHidden?: boolean;
  children: ReactNode;
}

/**
 * ???????????????????? ModuleVisibility ?????
 * ????/?????????????????
 */
export function SuspendedModulePanel({
  active,
  suspendWhenHidden = true,
  children,
}: SuspendedModulePanelProps) {
  const suspended = suspendWhenHidden && !active;
  return (
    <ModuleVisibilityProvider active={active} suspended={suspended}>
      <Suspense fallback={<RouteModuleFallback />}>{children}</Suspense>
    </ModuleVisibilityProvider>
  );
}
