import type { IDockviewPanelHeaderProps } from "dockview-react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useEffect, useRef } from "react";
import { DockTabChrome } from "./DockTabChrome";
import { DockTabIcon, type DockTabIconKind } from "./DockTabIcon";
import type { DockTabPageType } from "./dockableTab";
import { useDockTabLiveMeta } from "./dockTabLiveMeta";
import { logDockTabFile } from "./dockTabFileDebug";

interface PanelParams {
  tabId: string;
  label?: string;
  icon?: DockTabIconKind;
  tooltip?: string;
  type?: DockTabPageType;
  dirty?: boolean;
  saved?: boolean;
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
  const tabId = props.params?.tabId ?? props.api.id;
  const liveMeta = useDockTabLiveMeta(tabId);
  const label = props.params?.label ?? tabId;
  const icon = props.params?.icon;
  const tooltip = props.params?.tooltip ?? label;
  const pageType: DockTabPageType | undefined =
    liveMeta.type ?? props.params?.type;
  const dirty = pageType === "file" ? (liveMeta.dirty ?? props.params?.dirty) : undefined;
  const saved = pageType === "file" ? (liveMeta.saved ?? props.params?.saved) : undefined;
  const headerPosition = props.api.group.api.getHeaderPosition();
  const isSide = headerPosition === "left" || headerPosition === "right";

  const debugSigRef = useRef("");
  useEffect(() => {
    if (pageType !== "file") return;
    const sig = [
      tabId,
      props.api.id,
      pageType,
      String(dirty),
      String(saved),
      liveMeta.rev,
      JSON.stringify(props.params ?? {}),
      JSON.stringify(liveMeta),
    ].join("|");
    if (sig === debugSigRef.current) return;
    debugSigRef.current = sig;
    logDockTabFile("header", {
      tabId,
      apiId: props.api.id,
      tabIdMatch: tabId === props.api.id,
      params: props.params ?? null,
      liveMeta,
      resolved: { pageType, dirty, saved },
      isSide,
      mark: dirty ? "dirty" : saved ? "saved" : "none",
    });
  }, [tabId, props.api.id, pageType, dirty, saved, liveMeta, props.params, isSide]);

  const statusMark = dirty ? (
    <span className="dock-tab-dirty" aria-label="未保存" />
  ) : saved ? (
    <span className="dock-tab-saved" aria-label="已保存" />
  ) : null;

  return (
    <DockTabChrome
      {...props}
      closable={closable}
      tooltip={tooltip}
      onContextMenu={onContextMenu}
    >
      {icon ? <DockTabIcon kind={icon} /> : null}
      {!isSide ? (
        <>
          <span className="dock-tab-label">{label}</span>
          {statusMark}
        </>
      ) : statusMark ? (
        <span
          className={
            dirty
              ? "dock-tab-dirty dock-tab-dirty--side"
              : "dock-tab-saved dock-tab-dirty--side"
          }
          aria-label={dirty ? "未保存" : "已保存"}
        />
      ) : null}
    </DockTabChrome>
  );
}
