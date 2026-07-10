import type { MouseEvent } from "react";
import type { IDockviewPanelHeaderProps } from "dockview-react";
import { DockTabHeader } from "./DockTabHeader";
import { TopbarStyleDockTabHeader } from "./TopbarStyleDockTabHeader";
import type { DockHeaderIconKind } from "./DockHeaderIcon";
import type { DockTabPageType } from "./dockableTab";
import { useDockTabHeaderRuntime } from "./dockTabHeaderRuntime";
import { useDockTabLiveMeta } from "./dockTabLiveMeta";
import { omitReactKey } from "./omitReactKey";
import type { TopbarTabDef } from "../../stores/topbarStore";

interface PanelParams {
  tabId: string;
  label?: string;
  icon?: DockHeaderIconKind;
  tooltip?: string;
  status?: TopbarTabDef["status"];
  type?: DockTabPageType;
  dirty?: boolean;
  saved?: boolean;
  preview?: boolean;
}

/** dockview 使用的稳定 Tab 头组件（勿包在 useCallback 内，否则 hook 订阅会失效）。 */
export function DockWorkspaceTabHeader(
  props: IDockviewPanelHeaderProps<PanelParams>,
) {
  const tabId = props.params?.tabId ?? props.api.id;
  const liveMeta = useDockTabLiveMeta(tabId);
  const runtime = useDockTabHeaderRuntime();
  const tabsList = runtime?.tabsRef.current ?? [];
  const tab = tabsList.find((item) => item.id === tabId);

  const mergedParams: PanelParams = {
    tabId,
    label: tab?.label ?? liveMeta.label ?? props.params?.label,
    icon: tab?.icon ?? liveMeta.icon ?? props.params?.icon,
    tooltip: tab?.tooltip ?? props.params?.tooltip ?? tab?.label,
    status: tab?.status ?? props.params?.status,
    type: tab?.type ?? props.params?.type ?? liveMeta.type,
    dirty:
      liveMeta.rev > 0 && liveMeta.type === "file"
        ? liveMeta.dirty
        : tab?.type === "file"
          ? tab.dirty
          : props.params?.type === "file"
            ? props.params?.dirty
            : undefined,
    saved:
      liveMeta.rev > 0 && liveMeta.type === "file"
        ? liveMeta.saved
        : tab?.type === "file"
          ? tab.saved
          : props.params?.type === "file"
            ? props.params?.saved
            : undefined,
    preview:
      liveMeta.rev > 0
        ? Boolean(liveMeta.preview)
        : tab != null
          ? Boolean(tab.preview)
          : Boolean(props.params?.preview),
  };

  const closable = tab?.closable !== false;
  const onCtx = runtime?.onTabContextMenuRef.current;
  const handleContextMenu = onCtx
    ? (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const index = tabsList.findIndex((item) => item.id === tabId);
        onCtx(e, tabId, index >= 0 ? index : 0);
      }
    : undefined;

  const headerProps = omitReactKey(props);
  const tabStyle = runtime?.tabStyleRef.current ?? "default";

  if (tabStyle === "topbar") {
    return (
      <TopbarStyleDockTabHeader
        api={headerProps.api}
        containerApi={headerProps.containerApi}
        tabLocation={headerProps.tabLocation}
        params={mergedParams}
        closable={closable}
        onContextMenu={handleContextMenu}
      />
    );
  }

  return (
    <DockTabHeader
      api={headerProps.api}
      containerApi={headerProps.containerApi}
      tabLocation={headerProps.tabLocation}
      params={mergedParams}
      closable={closable}
      onContextMenu={handleContextMenu}
    />
  );
}
