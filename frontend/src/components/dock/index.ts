export { DockLayout } from "./DockLayout";
export { DockPanel } from "./DockPanel";
export { DockHandle } from "./DockHandle";
export { DockWorkspace, type DockRailPreset } from "./DockWorkspace";
export {
  DockableWorkspace,
  type DockableTab,
  type DockableWorkspaceProps,
  type DockviewSavedLayout,
} from "./DockableWorkspace";
export {
  ModuleSegmentDock,
  type ModuleSegmentDockProps,
  type ModuleSegmentTab,
} from "./ModuleSegmentDock";
export type { SerializedDockview } from "dockview-core";
export {
  collectPanelIds,
  createDefaultLayout,
  mergePanelsIntoLayout,
  removePanelFromLayout,
  diffRemovedPanelIds,
  normalizeDockLayout,
  describeDockLayout,
  type DockLayoutSnapshot,
  type DockGroupSnapshot,
  type DockPanelPlacement,
  type DockGroupRegion,
} from "./dockViewLayout";
export {
  resolveDockWindowChromeLayout,
  resolveSegmentWindowChromeHosts,
  type DockWindowChromeLayout,
} from "./dockWindowChromeLayout";
export {
  DOCK_PANEL_TYPES,
  PANEL_TYPE_PARAM,
  getTabGroupMeta,
  type DockPanelType,
  type TabGroupMeta,
} from "./dockPanelType";
export { syncTabGroupsByPanelType } from "./dockTabGroups";
