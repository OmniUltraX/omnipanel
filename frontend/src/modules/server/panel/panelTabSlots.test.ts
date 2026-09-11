import { describe, expect, it } from "vitest";
import { parsePluginManifest } from "@omnipanel/plugin-sdk";
import { setInstalledPluginManifests } from "../../../lib/pluginManifests";
import { listPanelDockTabs, listPanelSidebarTabs, resolvePanelDockKind } from "./panelTabIds";
import { PLUGIN_ID_PANEL_1PANEL, PLUGIN_ID_PANEL_BT, PLUGIN_ID_PANEL_HESTIA } from "./panelPlugin";

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
    expect(listPanelDockTabs(PLUGIN_ID_PANEL_HESTIA)).toEqual([
      "websites",
      "certificates",
      "cronjobs",
      "databases",
    ]);
    expect(listPanelSidebarTabs(PLUGIN_ID_PANEL_HESTIA)).toEqual([
      "websites",
      "certificates",
      "cronjobs",
      "databases",
    ]);
  });

  it("未知 panelTabs id 映射到通用壳", () => {
    const manifest = parsePluginManifest({
      id: "omni.panel.acme",
      version: "0.1.0",
      kind: "panel",
      methods: [{ name: "echo" }, { name: "listDatabases" }],
      contributes: {
        ui: {
          panelTabs: [
            { id: "overview" },
            { id: "databases" },
            {
              id: "echo",
              label: "回显",
              formFields: [{ key: "text", label: "文本" }],
              actions: [{ id: "create", method: "echo", target: "toolbar" }],
            },
          ],
        },
      },
    });
    setInstalledPluginManifests([manifest]);
    expect(listPanelDockTabs("omni.panel.acme")).toEqual(["databases", "echo"]);
    expect(resolvePanelDockKind("echo")).toBe("generic");
    expect(resolvePanelDockKind("databases")).toBe("first-party");
    expect(listPanelSidebarTabs("omni.panel.acme")).toEqual(["databases"]);
    setInstalledPluginManifests([]);
  });

  it("换未知 id 仍走通用壳（无样板 id 特判）", () => {
    expect(resolvePanelDockKind("echo")).toBe("generic");
    expect(resolvePanelDockKind("starter-tools")).toBe("generic");
  });
});
