import { describe, expect, it, vi } from "vitest";
import type { PluginHost } from "@omnipanel/plugin-sdk";
import {
  ensurePluginContributionsLoaded,
  resetPluginLifecycleForTests,
  syncPluginLifecycles,
} from "./pluginRuntimeLoader";
import { findPanelProbeMapper } from "./panelProbeRegistry";
import { getImporterContribution } from "./importerContributionRegistry";

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

    // 未激活：无映射器、无导入器贡献
    await sync([
      lifecycle("omni.panel.1panel", true, false),
      lifecycle("omni.importer.warpgate", true, false),
    ]);
    expect(findPanelProbeMapper("1panel")).toBeNull();
    expect(getImporterContribution("warpgate")).toBeNull();

    // 激活：贡献出现
    await sync([
      lifecycle("omni.panel.1panel", true, true),
      lifecycle("omni.importer.warpgate", true, true),
      lifecycle("omni.addon.everything", true, true),
    ]);
    expect(findPanelProbeMapper("1panel")?.pluginId).toBe("omni.panel.1panel");
    expect(getImporterContribution("warpgate")?.sampleOnly).toBe(true);

    // 禁用 1Panel：只卸除它，warpgate 不受影响
    await sync([
      lifecycle("omni.panel.1panel", false, false),
      lifecycle("omni.importer.warpgate", true, true),
    ]);
    expect(findPanelProbeMapper("1panel")).toBeNull();
    expect(getImporterContribution("warpgate")?.pluginId).toBe("omni.importer.warpgate");

    resetPluginLifecycleForTests();
  });

  it("面板探测 kind 命中与未注册 kind", async () => {
    resetPluginLifecycleForTests();
    ensurePluginContributionsLoaded();
    await sync([lifecycle("omni.panel.bt", true, true)]);

    expect(findPanelProbeMapper("baota")?.pluginId).toBe("omni.panel.bt");
    expect(findPanelProbeMapper("unknown-panel")).toBeNull();

    resetPluginLifecycleForTests();
  });

  it("warpgate 贡献产出示例候选且不写内网 IP", async () => {
    resetPluginLifecycleForTests();
    ensurePluginContributionsLoaded();
    await sync([lifecycle("omni.importer.warpgate", true, true)]);

    const candidates = getImporterContribution("warpgate")?.getPreviewCandidates("") ?? [];
    expect(candidates.length).toBeGreaterThan(0);
    for (const item of candidates) {
      expect(item.pluginId).toBe("omni.importer.warpgate");
      const host = (item.config as { host?: string }).host ?? "";
      expect(host).not.toMatch(/^10\./);
    }

    resetPluginLifecycleForTests();
  });
});
