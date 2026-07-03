import { type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { IDockviewPanelHeaderProps } from "dockview-react";
import { DockTabChrome } from "./DockTabChrome";
import { DockTabIcon, type DockTabIconKind } from "./DockTabIcon";
import type { DockTabPageType } from "./dockableTab";
import { useDockTabLiveMeta } from "./dockTabLiveMeta";
import { useDockTabHeaderRuntime } from "./dockTabHeaderRuntime";
import { useDockTabBarHidden } from "./useDockTabBarHidden";

interface PanelParams {
  tabId: string;
  label?: string;
  icon?: DockTabIconKind;
  tooltip?: string;
  type?: DockTabPageType;
  dirty?: boolean;
  saved?: boolean;
  preview?: boolean;
}

interface DockTabHeaderProps extends IDockviewPanelHeaderProps<PanelParams> {
  closable?: boolean;
  onContextMenu?: (event: ReactMouseEvent) => void;
  onPointerUp?: (event: ReactPointerEvent) => void;
}

export function DockTabHeader({
  closable = true,
  onContextMenu,
  onPointerUp,
  ...props
}: DockTabHeaderProps) {
  const tabId = props.params?.tabId ?? props.api.id;
  const liveMeta = useDockTabLiveMeta(tabId);
  const rootRef = useDockTabBarHidden(tabId, Boolean(liveMeta.tabBarHidden));
  const label = liveMeta.label ?? props.params?.label ?? tabId;
  const icon = liveMeta.icon ?? props.params?.icon;
  const tooltip = props.params?.tooltip ?? label;
  const pageType: DockTabPageType | undefined =
    liveMeta.type ?? props.params?.type;
  const dirty =
    pageType === "file" ? Boolean(liveMeta.dirty || props.params?.dirty) : undefined;
  const saved =
    pageType === "file"
      ? !dirty && Boolean(liveMeta.saved ?? props.params?.saved)
      : undefined;
  const preview =
    liveMeta.rev > 0
      ? Boolean(liveMeta.preview)
      : Boolean(props.params?.preview);
  const headerPosition = props.api.group.api.getHeaderPosition();
  const isSide = headerPosition === "left" || headerPosition === "right";
  const runtime = useDockTabHeaderRuntime();

  const handleDoubleClick = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    runtime?.onTabDoubleClickRef.current?.(tabId);
  };

  const statusMark = dirty ? (
    <span className="dock-tab-dirty" aria-label="未保存" />
  ) : saved ? (
    <span className="dock-tab-saved" aria-label="已保存" />
  ) : null;

  return (
    <div ref={rootRef} className="dock-tab-header-root">
      <DockTabChrome
      api={props.api}
      closable={closable}
      tooltip={tooltip}
      isPreview={preview}
      onContextMenu={onContextMenu}
      onPointerUp={onPointerUp}
      tabId={tabId}
      onDoubleClick={handleDoubleClick}
    >
      {icon ? <DockTabIcon kind={icon} /> : null}
      {!isSide ? (
        <>
          <span
            className={`dock-tab-label${preview ? " dock-tab-label--preview" : ""}`}
            style={preview ? { fontStyle: "italic" } : { fontStyle: "normal" }}
          >
            {label}
          </span>
          {statusMark}
        </>
      ) : (
        <>
          {!icon ? <span className="dock-tab-label">{label}</span> : null}
          {statusMark ? (
            <span
              className={
                dirty
                  ? "dock-tab-dirty dock-tab-dirty--side"
                  : "dock-tab-saved dock-tab-saved--side"
              }
              aria-label={dirty ? "未保存" : "已保存"}
            />
          ) : null}
        </>
      )}
    </DockTabChrome>
    </div>
  );
}
