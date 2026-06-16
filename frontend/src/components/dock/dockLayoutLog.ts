import type { DockviewApi } from "dockview-react";
import type { SerializedDockview } from "dockview-core";
import { describeDockLayout } from "./dockViewLayout";
import { resolveDockWindowChromeLayout } from "./dockWindowChromeLayout";

export type DockLayoutChangeSource =
  | "layout-change"
  | "initial-load"
  | "saved-layout";

export interface DockLayoutLogContext {
  dockScope?: string;
  className?: string;
  source: DockLayoutChangeSource;
}

/** 输出 DockableWorkspace 布局变动摘要，便于调试拖拽/分屏/持久化 */
export function logDockLayoutChange(
  layout: SerializedDockview,
  ctx: DockLayoutLogContext,
  api?: DockviewApi | null,
): void {
  const snapshot = describeDockLayout(layout);
  const chrome = resolveDockWindowChromeLayout(layout);

  console.log("[DockableWorkspace] layout change", {
    source: ctx.source,
    scope: ctx.dockScope ?? null,
    className: ctx.className ?? null,
    activeGroup: snapshot?.activeGroup ?? null,
    orientation: snapshot?.orientation ?? null,
    activePanel: api?.activePanel?.id ?? null,
    panelCount: snapshot?.panels.length ?? 0,
    groups: snapshot?.groups ?? [],
    panels: snapshot?.panels ?? [],
    windowChrome: chrome
      ? {
          dragGroupId: chrome.dragGroupId,
          controlsGroupId: chrome.controlsGroupId,
          dragPanelId: chrome.dragPanelId,
          controlsPanelId: chrome.controlsPanelId,
        }
      : null,
  });
}
