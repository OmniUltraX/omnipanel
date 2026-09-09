import { describe, expect, it, vi } from "vitest";
import type { PluginHost } from "@omnipanel/plugin-sdk";
import {
  DYNAMIC_UI_MAX_BYTES,
  ensurePluginContributionsLoaded,
  evaluateDynamicPluginModule,
  getDynamicUiUnsupportedReason,
  resetPluginLifecycleForTests,
  setPluginAssetReader,
  syncPluginLifecycles,
  UI_INVALID_ENTRY_REASON,
} from "./pluginRuntimeLoader";
import { findPanelProbeMapper } from "./panelProbeRegistry";
import { findPanelDriver } from "./panelDriverRegistry";
import { setInstalledPluginManifests } from "./pluginManifests";

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
    expect(findPanelDriver("omni.panel.1panel")?.getDashboard).toEqual(expect.any(Function));
    expect(findPanelDriver("omni.panel.1panel")?.listWebsites).toEqual(expect.any(Function));

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
    expect(findPanelDriver("omni.panel.bt")?.getDashboard).toEqual(expect.any(Function));
    expect(findPanelDriver("omni.panel.bt")?.remoteWebsiteFilter).toBe(true);
    expect(findPanelProbeMapper("unknown-panel")).toBeNull();

    resetPluginLifecycleForTests();
  });

  it("第三方动态 ui/main.js 可激活，非法入口降级为 L1", async () => {
    resetPluginLifecycleForTests();
    ensurePluginContributionsLoaded();
    setInstalledPluginManifests([
      {
        id: "omni.test.dynamic",
        version: "0.1.0",
        kind: "addon",
        permissions: [],
        methods: [],
        entry: { ui: "ui/main.js" },
        contributes: {},
      } as never,
      {
        id: "omni.test.bad",
        version: "0.1.0",
        kind: "addon",
        permissions: [],
        methods: [],
        entry: { ui: "ui/main.js" },
        contributes: {},
      } as never,
    ]);
    const activated: string[] = [];
    const deactivated: string[] = [];
    setPluginAssetReader(async (pluginId) => {
      if (pluginId === "omni.test.dynamic") {
        return `module.exports = definePlugin({ activate: async () => { globalThis.__dynActivated = "yes"; }, deactivate: () => {} });`;
      }
      return `this is not js {{{`;
    });
    const dynamicFactory = vi.fn(async (id: string) => {
      if (id === "omni.test.dynamic") {
        return {
          selection: { get: () => null },
          connections: { upsert: async () => {} },
          invoke: async () => {
            activated.push(id);
            return null;
          },
          ui: { overlay: { show: () => {}, hide: () => {} } },
        } as unknown as PluginHost;
      }
      return stubHost;
    });
    // 求值单元：合法与非法
    expect(
      evaluateDynamicPluginModule(`module.exports = definePlugin({ activate: () => {} });`, {
        host: stubHost,
        manifest: {},
      })?.activate,
    ).toEqual(expect.any(Function));
    expect(
      evaluateDynamicPluginModule(`this is not js {{{`, { host: stubHost, manifest: {} }),
    ).toBeNull();

    await syncPluginLifecycles(
      [lifecycle("omni.test.dynamic", true, true), lifecycle("omni.test.bad", true, true)],
      dynamicFactory,
    );
    expect((globalThis as Record<string, unknown>).__dynActivated).toBe("yes");

    await syncPluginLifecycles([], dynamicFactory);
    expect(deactivated).toEqual([]);
    setInstalledPluginManifests([]);
    resetPluginLifecycleForTests();
    delete (globalThis as Record<string, unknown>).__dynActivated;
  });

  it("非法 activate 形状、超体积、隔离失败互不影响", async () => {
    resetPluginLifecycleForTests();
    ensurePluginContributionsLoaded();
    setInstalledPluginManifests([
      {
        id: "omni.test.ok",
        version: "0.1.0",
        kind: "addon",
        permissions: [],
        methods: [],
        entry: { ui: "ui/main.js" },
        contributes: {},
      } as never,
      {
        id: "omni.test.shape",
        version: "0.1.0",
        kind: "addon",
        permissions: [],
        methods: [],
        entry: { ui: "ui/main.js" },
        contributes: {},
      } as never,
      {
        id: "omni.test.boom",
        version: "0.1.0",
        kind: "addon",
        permissions: [],
        methods: [],
        entry: { ui: "ui/main.js" },
        contributes: {},
      } as never,
    ]);
    setPluginAssetReader(async (pluginId) => {
      if (pluginId === "omni.test.ok") {
        return `module.exports = definePlugin({ activate: () => { globalThis.__okUi = true; }, deactivate: () => {} });`;
      }
      if (pluginId === "omni.test.boom") {
        return `module.exports = definePlugin({ activate: () => { throw new Error("boom"); } });`;
      }
      return `module.exports = { deactivate: function () {} };`;
    });

    expect(
      evaluateDynamicPluginModule(`module.exports = { hello: 1 };`, {
        host: stubHost,
        manifest: {},
      }),
    ).toBeNull();
    expect(
      evaluateDynamicPluginModule(`module.exports = { deactivate: function () {} };`, {
        host: stubHost,
        manifest: {},
      }),
    ).toBeNull();
    expect(
      evaluateDynamicPluginModule("x".repeat(DYNAMIC_UI_MAX_BYTES + 1), {
        host: stubHost,
        manifest: {},
      }),
    ).toBeNull();

    await syncPluginLifecycles(
      [
        lifecycle("omni.test.ok", true, true),
        lifecycle("omni.test.shape", true, true),
        lifecycle("omni.test.boom", true, true),
      ],
      stubFactory,
    );
    expect((globalThis as Record<string, unknown>).__okUi).toBe(true);
    expect(getDynamicUiUnsupportedReason("omni.test.shape")).toBe(UI_INVALID_ENTRY_REASON);
    expect(getDynamicUiUnsupportedReason("omni.test.boom")).toBe(UI_INVALID_ENTRY_REASON);
    expect(getDynamicUiUnsupportedReason("omni.test.ok")).toBeUndefined();

    setInstalledPluginManifests([]);
    resetPluginLifecycleForTests();
    delete (globalThis as Record<string, unknown>).__okUi;
  });
});
