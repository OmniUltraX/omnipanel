import { describe, expect, it, vi } from "vitest";
import type { PluginHost } from "@omnipanel/plugin-sdk";
import {
  ensurePluginContributionsLoaded,
  resetPluginLifecycleForTests,
  syncPluginLifecycles,
} from "./pluginRuntimeLoader";
import { findPanelProbeMapper } from "./panelProbeRegistry";
import { findPanelDriver } from "./panelDriverRegistry";

const stubHost = {} as PluginHost;
const stubFactory = vi.fn(async () => stubHost);

function lifecycle(id: string, enabled: boolean, activated: boolean) {
  return { id, enabled, activated };
}

async function sync(items: ReturnType<typeof lifecycle>[]) {
  await syncPluginLifecycles(items, stubFactory);
}

describe("pluginRuntimeLoader 差量生命周期", () => {
  it("激活插件时登记贡献，禁用时卸除（先卸后启）", async () => {
    resetPluginLifecycleForTests();
    ensurePluginContributionsLoaded();

    await sync([lifecycle("omni.panel.1panel", true, false)]);
    expect(findPanelProbeMapper("1panel")).toBeNull();

    await sync([
      lifecycle("omni.panel.1panel", true, true),
      lifecycle("omni.addon.everything", true, true),
    ]);
    expect(findPanelProbeMapper("1panel")?.pluginId).toBe("omni.panel.1panel");
    expect(findPanelDriver("omni.panel.1panel")?.listDatabases).toEqual(expect.any(Function));

    await sync([lifecycle("omni.panel.1panel", false, false)]);
    expect(findPanelProbeMapper("1panel")).toBeNull();
    expect(findPanelDriver("omni.panel.1panel")).toBeNull();

    resetPluginLifecycleForTests();
  });

  it("面板探测 kind 命中与未注册 kind", async () => {
    resetPluginLifecycleForTests();
    ensurePluginContributionsLoaded();
    await sync([lifecycle("omni.panel.bt", true, true)]);

    expect(findPanelProbeMapper("baota")?.pluginId).toBe("omni.panel.bt");
    expect(findPanelDriver("omni.panel.bt")?.createDatabase).toEqual(expect.any(Function));
    expect(findPanelProbeMapper("unknown-panel")).toBeNull();

    resetPluginLifecycleForTests();
  });
});
