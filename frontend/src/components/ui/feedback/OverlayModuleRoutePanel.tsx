import type { ReactNode } from "react";
import { SuspendedModulePanel } from "./SuspendedModulePanel";

interface OverlayModuleRoutePanelProps {
  active: boolean;
  /** 首次访问前不挂载（lazy） */
  mounted?: boolean;
  suspendWhenHidden?: boolean;
  children: ReactNode;
}

/** dock 模块叠层路由：始终 absolute 铺满，仅切 visibility */
export function OverlayModuleRoutePanel({
  active,
  mounted = true,
  suspendWhenHidden = true,
  children,
}: OverlayModuleRoutePanelProps) {
  if (!mounted) return null;

  return (
    <div
      className={`route-panel route-panel--overlay${active ? " route-panel--active" : ""}`}
    >
      <SuspendedModulePanel active={active} suspendWhenHidden={suspendWhenHidden}>
        {children}
      </SuspendedModulePanel>
    </div>
  );
}
