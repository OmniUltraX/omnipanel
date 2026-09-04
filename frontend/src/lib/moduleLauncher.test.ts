import { describe, expect, it } from "vitest";
import { parsePluginManifest } from "@omnipanel/plugin-sdk";
import { setInstalledPluginManifests } from "./pluginManifests";
import { syncModuleLauncherProviders } from "./moduleLauncher";
import { parseQuickLaunchQuery } from "./quickLauncherMatch";

describe("syncModuleLauncherProviders", () => {
  it("启用时登记前缀，禁用后卸除", () => {
    const manifest = parsePluginManifest({
      id: "omni.module.demo",
      version: "0.1.0",
      kind: "module",
      contributes: {
        ui: { moduleKey: "demo" },
        launcher: { prefix: "demo" },
      },
    });
    setInstalledPluginManifests([manifest]);
    syncModuleLauncherProviders([{ id: "omni.module.demo", enabled: true, activated: true }]);
    expect(parseQuickLaunchQuery("demo foo")).toMatchObject({
      kind: "module",
      filter: "foo",
      pluginId: "omni.module.demo",
      moduleKey: "demo",
    });
    syncModuleLauncherProviders([{ id: "omni.module.demo", enabled: false, activated: false }]);
    expect(parseQuickLaunchQuery("demo foo").kind).toBe("plain");
    setInstalledPluginManifests([]);
  });

  it("addon 启动条前缀启用时可搜到，禁用后卸除", () => {
    const manifest = parsePluginManifest({
      id: "omni.addon.starter",
      version: "0.1.0",
      kind: "addon",
      contributes: {
        launcher: { prefix: "starter" },
      },
    });
    setInstalledPluginManifests([manifest]);
    syncModuleLauncherProviders([{ id: "omni.addon.starter", enabled: true, activated: true }]);
    expect(parseQuickLaunchQuery("starter foo")).toMatchObject({
      kind: "module",
      filter: "foo",
      pluginId: "omni.addon.starter",
      prefix: "starter",
    });
    syncModuleLauncherProviders([{ id: "omni.addon.starter", enabled: false, activated: false }]);
    expect(parseQuickLaunchQuery("starter foo").kind).toBe("plain");
    setInstalledPluginManifests([]);
  });
});
