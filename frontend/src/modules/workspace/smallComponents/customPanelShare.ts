import {
  isHomeCustomPanelId,
  useDashboardStore,
  type HomeCustomPanelId,
} from "../useDashboardStore";
import type { HomeCustomPanelWidget } from "./types";

/** 可经局域网 UDP 分享的自定义面板快照（不含敏感凭据，仅布局与绑定 id）。 */
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

export function parseCustomPanelShareSnapshot(
  raw: unknown,
): CustomPanelShareSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  if (rec.kind !== "custom-panel") return null;
  if (typeof rec.label !== "string" || !rec.label.trim()) return null;
  if (!Array.isArray(rec.widgets)) return null;
  return {
    v: 1,
    kind: "custom-panel",
    label: rec.label.trim(),
    widgets: rec.widgets as HomeCustomPanelWidget[],
  };
}
