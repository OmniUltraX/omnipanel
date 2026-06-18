import { Panel } from "react-resizable-panels";
import type { PanelProps, PanelImperativeHandle } from "react-resizable-panels";

interface DockPanelProps {
  children: React.ReactNode;
  defaultSize?: PanelProps["defaultSize"];
  minSize?: PanelProps["minSize"];
  maxSize?: PanelProps["maxSize"];
  collapsible?: boolean;
  collapsedSize?: PanelProps["collapsedSize"];
  onResize?: PanelProps["onResize"];
  groupResizeBehavior?: PanelProps["groupResizeBehavior"];
  panelRef?: React.Ref<PanelImperativeHandle | null>;
  className?: string;
}

export function DockPanel({
  children,
  defaultSize,
  minSize,
  maxSize,
  collapsible,
  collapsedSize,
  onResize,
  groupResizeBehavior,
  panelRef,
  className,
}: DockPanelProps) {
  return (
    <Panel
      panelRef={panelRef}
      defaultSize={defaultSize}
      minSize={minSize}
      maxSize={maxSize}
      collapsible={collapsible}
      collapsedSize={collapsedSize}
      onResize={onResize}
      groupResizeBehavior={groupResizeBehavior}
      className={`dock-panel${className ? ` ${className}` : ""}`}
    >
      {children}
    </Panel>
  );
}
