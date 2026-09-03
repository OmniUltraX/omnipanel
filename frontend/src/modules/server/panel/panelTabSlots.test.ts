import { describe, expect, it } from "vitest";
import { listPanelDockTabs, listPanelSidebarTabs } from "./panelTabIds";
import { PLUGIN_ID_PANEL_1PANEL, PLUGIN_ID_PANEL_BT } from "./panelPlugin";

describe("panelTabSlots", () => {
  it("1Panel / 宝塔 Dock 含 databases", () => {
    expect(listPanelDockTabs(PLUGIN_ID_PANEL_1PANEL)).toEqual([
      "apps",
      "websites",
      "certificates",
      "cronjobs",
      "databases",
    ]);
    expect(listPanelDockTabs(PLUGIN_ID_PANEL_BT)).toEqual([
      "apps",
      "websites",
      "certificates",
      "cronjobs",
      "databases",
    ]);
  });

  it("侧栏不含应用市场，含 databases", () => {
    expect(listPanelSidebarTabs(PLUGIN_ID_PANEL_BT)).toEqual([
      "websites",
      "certificates",
      "cronjobs",
      "databases",
    ]);
    expect(listPanelSidebarTabs(PLUGIN_ID_PANEL_1PANEL)).toEqual([
      "websites",
      "certificates",
      "cronjobs",
      "databases",
    ]);
  });
});
