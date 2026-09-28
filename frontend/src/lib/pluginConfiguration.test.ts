import { describe, expect, it } from "vitest";
import type { PluginManifest } from "@omnipanel/plugin-sdk";
import {
  parsePluginConfiguration,
  pluginHasConfiguration,
  resolvePluginConfiguration,
} from "./pluginConfiguration";

function manifestWithConfig(configuration: unknown): PluginManifest {
  return {
    id: "omni.test.cfg",
    version: "0.1.0",
    kind: "addon",
    permissions: [],
    dependencies: [],
    entry: {},
    contributes: {
      configuration: configuration as PluginManifest["contributes"]["configuration"],
    },
  } as PluginManifest;
}

describe("pluginConfiguration", () => {
  it("解析 VS Code 风格 properties 并按 order 排序", () => {
    const resolved = resolvePluginConfiguration(
      manifestWithConfig({
        title: "Demo",
        properties: {
          beta: { type: "boolean", default: false, order: 2 },
          token: { type: "string", format: "password", order: 1, secret: true },
          name: { type: "string", default: "x", order: 0, description: "显示名" },
        },
      }),
    );
    expect(resolved?.title).toBe("Demo");
    expect(resolved?.fields.map((f) => f.key)).toEqual(["name", "token", "beta"]);
    expect(resolved?.fields[1]?.kind).toBe("password");
    expect(resolved?.fields[1]?.secret).toBe(true);
  });

  it("支持 fields + panel；空声明返回 null；Warpgate 有宿主回退", () => {
    expect(resolvePluginConfiguration(manifestWithConfig({ title: "空" }))).toBeNull();
    const withPanel = resolvePluginConfiguration(
      manifestWithConfig({ title: "WG", panel: "warpgate.gateways" }),
    );
    expect(withPanel?.panel).toBe("warpgate.gateways");
    expect(withPanel?.fields).toEqual([]);

    const withFields = resolvePluginConfiguration(
      manifestWithConfig({
        fields: [{ key: "baseUrl", kind: "url", label: "地址", required: true }],
      }),
    );
    expect(withFields?.fields).toHaveLength(1);
    expect(withFields?.fields[0]?.kind).toBe("url");

    // 无清单 configuration 时仍能靠 pluginId 回退到内置面板
    expect(resolvePluginConfiguration("omni.addon.warpgate")?.panel).toBe("warpgate.gateways");
  });

  it("parsePluginConfiguration 拒绝无效片段；已安装列表恒可开设置", () => {
    expect(parsePluginConfiguration({ title: "only" })).toBeNull();
    expect(
      parsePluginConfiguration({ panel: "warpgate.gateways", title: "WG" }),
    ).toMatchObject({ panel: "warpgate.gateways" });
    expect(pluginHasConfiguration(null)).toBe(true);
  });
});
