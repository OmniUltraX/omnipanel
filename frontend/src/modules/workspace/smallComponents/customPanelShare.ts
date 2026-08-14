import {
  isHomeCustomPanelId,
  useDashboardStore,
  type HomeCustomPanelId,
} from "../useDashboardStore";
import type { HomeCustomPanelWidget } from "./types";

/** 可分享的自定义面板快照（不含敏感凭据，仅布局与绑定 id）。 */
export type CustomPanelShareSnapshot = {
  v: 1;
  kind: "custom-panel";
  label: string;
  widgets: HomeCustomPanelWidget[];
};

export function buildCustomPanelShareSnapshot(
  panelId: string,
): CustomPanelShareSnapshot | null {
  if (!isHomeCustomPanelId(panelId)) return null;
  const panel = useDashboardStore.getState().customPanels[panelId as HomeCustomPanelId];
  if (!panel) return null;
  return {
    v: 1,
    kind: "custom-panel",
    label: panel.label,
    widgets: panel.widgets.map((w) => ({ ...w })),
  };
}
