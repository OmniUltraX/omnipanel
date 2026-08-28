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

function newWidgetInstanceId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `w-${crypto.randomUUID()}`;
  }
  return `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

/** 从团队分享快照导入为本机新的自定义面板。 */
export function importCustomPanelShareSnapshot(
  snapshot: CustomPanelShareSnapshot,
): HomeCustomPanelId | null {
  if (snapshot.kind !== "custom-panel") return null;
  const panelId = useDashboardStore.getState().createCustomPanel(snapshot.label);
  useDashboardStore.setState((state) => {
    const panel = state.customPanels[panelId];
    if (!panel) return state;
    return {
      customPanels: {
        ...state.customPanels,
        [panelId]: {
          ...panel,
          widgets: snapshot.widgets.map((widget) => ({
            ...widget,
            id: newWidgetInstanceId(),
            layout: { ...widget.layout },
          })),
        },
      },
    };
  });
  void import("../../clientSync/moduleSync").then((mod) => {
    mod.scheduleClientModuleSync();
  });
  return panelId;
}
