import { describe, expect, it } from "vitest";
import { getPluginMarketIcon } from "./pluginMarketIcons";

describe("getPluginMarketIcon", () => {
  it("为云厂商返回品牌图（AWS 区分明暗）", () => {
    expect(getPluginMarketIcon("omni.cloud.aliyun", "cloud", "light")).toBeTruthy();
    expect(getPluginMarketIcon("omni.cloud.tencent", "cloud", "dark")).toBeTruthy();
    const awsLight = getPluginMarketIcon("omni.cloud.aws", "cloud", "light");
    const awsDark = getPluginMarketIcon("omni.cloud.aws", "cloud", "dark");
    expect(awsLight).toBeTruthy();
    expect(awsDark).toBeTruthy();
    expect(awsLight).not.toBe(awsDark);
  });

  it("为面板与 Docker 导入器返回品牌图", () => {
    expect(getPluginMarketIcon("omni.panel.bt", "panel", "light")).toBeTruthy();
    expect(getPluginMarketIcon("omni.panel.1panel", "panel", "dark")).toBeTruthy();
    expect(getPluginMarketIcon("omni.panel.hestia", "panel", "light")).toBeTruthy();
    expect(getPluginMarketIcon("omni.importer.docker-db", "importer", "light")).toBeTruthy();
  });

  it("为 Obsidian（SVGL）返回图标；未知插件返回 null", () => {
    expect(getPluginMarketIcon("omni.knowledge.obsidian", "knowledge", "light")).toBeTruthy();
    expect(getPluginMarketIcon("omni.module.nacos", "module", "light")).toBeNull();
    expect(getPluginMarketIcon("omni.theme.default", "theme", "light")).toBeNull();
  });

  it("引擎走 engineIcons（MySQL 有图）", () => {
    expect(getPluginMarketIcon("omni.engine.mysql", "engine", "light")).toBeTruthy();
    expect(getPluginMarketIcon("omni.engine.mysql", "engine", "dark")).toBeTruthy();
  });
});
