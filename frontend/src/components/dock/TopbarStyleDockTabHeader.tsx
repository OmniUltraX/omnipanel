import type { IDockviewPanelHeaderProps } from "dockview-react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import type { TopbarTabDef } from "../../stores/topbarStore";
import { DockTabChrome } from "./DockTabChrome";
import type { DockTabPageType } from "./dockableTab";
import { useDockTabLiveMeta } from "./dockTabLiveMeta";
import { useDockTabHeaderRuntime } from "./dockTabHeaderRuntime";
import { useDockTabBarHidden } from "./useDockTabBarHidden";

interface PanelParams {
  tabId: string;
  label?: string;
  status?: TopbarTabDef["status"];
  tooltip?: string;
  type?: DockTabPageType;
  dirty?: boolean;
  saved?: boolean;
  preview?: boolean;
}

interface TopbarStyleDockTabHeaderProps
  extends IDockviewPanelHeaderProps<PanelParams> {
  closable?: boolean;
  onContextMenu?: (event: ReactMouseEvent) => void;
  onPointerUp?: (event: ReactPointerEvent) => void;
}

function tabStatusClass(status?: string) {
  if (status === "connected" || status === "online") return "online";
  if (status === "connecting") return "connecting";
  if (status === "offline") return "offline";
  return "idle";
}

export function TopbarStyleDockTabHeader({
  closable = true,
  onContextMenu,
  onPointerUp,
  ...props
}: TopbarStyleDockTabHeaderProps) {
  const tabId = props.params?.tabId ?? props.api.id;
  const liveMeta = useDockTabLiveMeta(tabId);
  const rootRef = useDockTabBarHidden(tabId, Boolean(liveMeta.tabBarHidden));
  const label = liveMeta.label ?? props.params?.label ?? tabId;
  const status = props.params?.status;
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
  const runtime = useDockTabHeaderRuntime();

  const handleDoubleClick = (event: ReactMouseEvent) => {
    if (!preview) {
      return;
    }
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
      {...props}
      closable={closable}
      tooltip={tooltip}
      isPreview={preview}
      tabId={tabId}
      onContextMenu={onContextMenu}
      onPointerUp={onPointerUp}
      onDoubleClick={handleDoubleClick}
    >
      {status ? (
        <span className={`topbar-tab-dot ${tabStatusClass(status)}`} />
      ) : null}
      <span
        className={`dock-tab-label${preview ? " dock-tab-label--preview" : ""}`}
        style={preview ? { fontStyle: "italic" } : { fontStyle: "normal" }}
      >
        {label}
      </span>
      {statusMark}
    </DockTabChrome>
    </div>
  );
}
