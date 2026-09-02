import { describe, expect, it } from "vitest";
import { parsePluginManifest } from "@omnipanel/plugin-sdk";
import {
  isKnownModuleCapability,
  manifestModuleCapabilities,
  parseServiceConfig,
  servicePluginId,
} from "./moduleCapabilities";

describe("moduleCapabilities", () => {
  it("只声明 config 时无服务节点", () => {
    const manifest = parsePluginManifest({
      id: "omni.module.demo",
      version: "0.1.0",
      kind: "module",
      contributes: {
        ui: { moduleKey: "demo" },
        module: { capabilities: [{ id: "config" }] },
      },
    });
    expect(manifestModuleCapabilities(manifest).map((c) => c.id)).toEqual(["config"]);
    expect(manifestModuleCapabilities(manifest).some((c) => c.id === "discovery")).toBe(false);
  });

  it("未知能力 id 仍可声明", () => {
    const manifest = parsePluginManifest({
      id: "omni.module.demo",
      version: "0.1.0",
      kind: "module",
      contributes: {
        module: { capabilities: [{ id: "topic" }] },
      },
    });
    expect(isKnownModuleCapability("topic")).toBe(false);
    expect(manifestModuleCapabilities(manifest)[0]?.id).toBe("topic");
  });

  it("重复能力 id 校验失败", () => {
    expect(() =>
      parsePluginManifest({
        id: "omni.module.demo",
        version: "0.1.0",
        kind: "module",
        contributes: {
          module: { capabilities: [{ id: "config" }, { id: "config" }] },
        },
      }),
    ).toThrow(/重复/);
  });

  it("service config 解析 pluginId", () => {
    expect(servicePluginId('{"pluginId":"omni.module.nacos"}')).toBe("omni.module.nacos");
    expect(parseServiceConfig("").pluginId).toBeUndefined();
  });
});
