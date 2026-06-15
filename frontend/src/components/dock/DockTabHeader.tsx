import {
  DockviewDefaultTab,
  type IDockviewPanelHeaderProps,
} from "dockview-react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { DockTabIcon, type DockTabIconKind } from "./DockTabIcon";

interface PanelParams {
  tabId: string;
  label?: string;
  icon?: DockTabIconKind;
  tooltip?: string;
}

interface DockTabHeaderProps extends IDockviewPanelHeaderProps<PanelParams> {
  closable?: boolean;
  onContextMenu?: (event: ReactMouseEvent) => void;
}

export function DockTabHeader({
  closable = true,
  onContextMenu,
  ...props
}: DockTabHeaderProps) {
  const label = props.params?.label ?? props.params?.tabId ?? props.api.id;
  const icon = props.params?.icon;
  const tooltip = props.params?.tooltip ?? label;
  const headerPosition = props.api.group.api.getHeaderPosition();
  const isSide = headerPosition === "left" || headerPosition === "right";

  return (
    <DockviewDefaultTab
      {...props}
      hideClose={!closable}
      onContextMenu={onContextMenu}
      title={tooltip}
    >
      <span className="dock-tab-header-inner">
        {icon ? <DockTabIcon kind={icon} /> : null}
        {!isSide ? <span className="dock-tab-label">{label}</span> : null}
      </span>
    </DockviewDefaultTab>
  );
}
