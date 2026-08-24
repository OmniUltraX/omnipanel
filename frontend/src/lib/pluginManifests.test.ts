import { describe, expect, it } from "vitest";
import {
  FIRST_PARTY_PLUGIN_MANIFESTS,
  getPluginManifest,
  listPluginManifests,
  manifestPanelTabIds,
  resolveLegacyPluginId,
} from "./pluginManifests";

describe("pluginManifests 单源目录", () => {
  it("解析全部第一方清单且 id 唯一", () => {
    const ids = FIRST_PARTY_PLUGIN_MANIFESTS.map((m) => m.id);
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(10);
  });

  it("kind 分布与仓库样板一致", () => {
    expect(listPluginManifests("engine").map((m) => m.id)).toEqual([
      "omni.engine.clickhouse",
      "omni.engine.qdrant",
      "omni.engine.redis",
    ]);
    expect(listPluginManifests("panel")).toHaveLength(2);
    expect(listPluginManifests("module")).toHaveLength(1);
    expect(listPluginManifests("cloud")).toHaveLength(1);
    expect(listPluginManifests("theme")).toHaveLength(1);
    expect(listPluginManifests("addon")).toHaveLength(1);
    expect(listPluginManifests("importer")).toHaveLength(1);
  });

  it("getPluginManifest 命中与未命中", () => {
    expect(getPluginManifest("omni.panel.bt")?.kind).toBe("panel");
    expect(getPluginManifest("omni.unknown")).toBeNull();
  });

  it("manifestPanelTabIds 提取有效 id", () => {
    const bt = getPluginManifest("omni.panel.bt");
    expect(manifestPanelTabIds(bt)).toEqual([
      "overview",
      "websites",
      "apps",
      "certificates",
      "cronjobs",
      "databases",
    ]);
    expect(manifestPanelTabIds(null)).toEqual([]);
  });

  it("legacy 别名解析到插件 id", () => {
    expect(resolveLegacyPluginId("aliyun")).toBe("omni.cloud.aliyun");
    expect(resolveLegacyPluginId(" omni.cloud.aliyun ")).toBe("omni.cloud.aliyun");
    expect(resolveLegacyPluginId("unknown-provider")).toBeNull();
    expect(resolveLegacyPluginId("")).toBeNull();
  });
});
