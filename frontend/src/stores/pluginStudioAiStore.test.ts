import { describe, expect, it } from "vitest";
import {
  EMPTY_PLUGIN_STUDIO_AI_SNAPSHOT,
  formatPluginStudioAiContext,
} from "./pluginStudioAiStore";

describe("formatPluginStudioAiContext", () => {
  it("inactive snapshot yields null", () => {
    expect(formatPluginStudioAiContext(EMPTY_PLUGIN_STUDIO_AI_SNAPSHOT)).toBeNull();
  });

  it("active empty project still explains the scene", () => {
    const text = formatPluginStudioAiContext({
      ...EMPTY_PLUGIN_STUDIO_AI_SNAPSHOT,
      active: true,
    });
    expect(text).toContain("尚未选择工程");
  });

  it("includes project kind file and tool hint", () => {
    const text = formatPluginStudioAiContext({
      ...EMPTY_PLUGIN_STUDIO_AI_SNAPSHOT,
      active: true,
      project: "demo",
      displayName: "Demo",
      kind: "addon",
      file: "plugin.json",
      files: ["plugin.json", "ui/main.js"],
      dirty: true,
      fileExcerpt: '{ "kind": "addon" }',
    });
    expect(text).toContain("demo");
    expect(text).toContain("addon");
    expect(text).toContain("plugin.json");
    expect(text).toContain("未保存");
    expect(text).toContain("omni_studio_write_file");
  });
});
