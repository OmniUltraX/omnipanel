import { beforeEach, describe, expect, it } from "vitest";
import { parsePluginManifest } from "@omnipanel/plugin-sdk";
import type { PluginListItem } from "../ipc/bindings";
import { setInstalledPluginManifests } from "./pluginManifests";
import {
  listEligibleHomePlugins,
  listPinnedHomePlugins,
  parsePluginHomeContribution,
} from "./pluginHomeContribution";
import { resolvePluginIconPath } from "./pluginHomeLaunch";

function item(id: string, enabled = true, activated = true): PluginListItem {
  return {
    id,
    version: "0.1.0",
    kind: "importer",
    enabled,
    activated,
    source: "builtin",
  };
}

const warpgateManifest = parsePluginManifest({
  id: "omni.importer.warpgate",
  version: "0.2.0",
  kind: "importer",
  permissions: [],
  contributes: {
    ui: {
      home: {
        show: true,
        title: "plugins.names.warpgate",
        icon: "icon.svg",
        open: { kind: "importer", id: "warpgate" },
      },
    },
  },
});

describe("pluginHomeLaunch", () => {
  beforeEach(() => {
    setInstalledPluginManifests([warpgateManifest]);
  });

  it("解析首页贡献点", () => {
    const home = parsePluginHomeContribution(warpgateManifest);
    expect(home?.open.kind).toBe("importer");
    expect(home?.open.id).toBe("warpgate");
    expect(home?.icon).toBe("icon.svg");
  });

  it("仅已启用且已激活的插件有资格", () => {
    expect(listEligibleHomePlugins([item("omni.importer.warpgate", false, true)])).toEqual([]);
    expect(listEligibleHomePlugins([item("omni.importer.warpgate", true, false)])).toEqual([]);
    const eligible = listEligibleHomePlugins([item("omni.importer.warpgate")]);
    expect(eligible).toHaveLength(1);
    expect(eligible[0]?.pluginId).toBe("omni.importer.warpgate");
    expect(eligible[0]?.home.open).toEqual({ kind: "importer", id: "warpgate" });
  });

  it("拒绝外链图标", () => {
    expect(() =>
      parsePluginManifest({
        id: "omni.test.home",
        version: "0.1.0",
        kind: "addon",
        permissions: [],
        contributes: {
          ui: {
            home: {
              title: "Evil",
              icon: "https://example.com/a.png",
              open: { kind: "overlay", id: "x" },
            },
          },
        },
      }),
    ).toThrow();
    expect(() =>
      parsePluginManifest({
        id: "omni.test.icon",
        version: "0.1.0",
        kind: "addon",
        icon: "https://example.com/a.png",
        permissions: [],
        contributes: {},
      }),
    ).toThrow();
  });

  it("resolvePluginIconPath 优先顶层 icon，再回退 home.icon，并按主题选 light/dark", () => {
    const withTop = parsePluginManifest({
      id: "omni.test.icon-top",
      version: "0.1.0",
      kind: "addon",
      icon: "brand.png",
      permissions: [],
      contributes: {
        ui: {
          home: {
            title: "T",
            icon: "home.svg",
            open: { kind: "overlay", id: "x" },
          },
        },
      },
    });
    expect(resolvePluginIconPath(withTop, "light")).toBe("brand.png");
    expect(resolvePluginIconPath(warpgateManifest, "dark")).toBe("icon.svg");

    const themed = parsePluginManifest({
      id: "omni.test.icon-themed",
      version: "0.1.0",
      kind: "addon",
      icon: { light: "a-light.svg", dark: "a-dark.svg" },
      permissions: [],
      contributes: {},
    });
    expect(resolvePluginIconPath(themed, "light")).toBe("a-light.svg");
    expect(resolvePluginIconPath(themed, "dark")).toBe("a-dark.svg");
  });

  it("用户取消钉选后不出现在启动条", () => {
    const items = [item("omni.importer.warpgate")];
    expect(listPinnedHomePlugins(items, [], []).map((e) => e.pluginId)).toEqual([
      "omni.importer.warpgate",
    ]);
    expect(listPinnedHomePlugins(items, ["omni.importer.warpgate"], [])).toEqual([]);
  });
});
