import { describe, expect, it } from "vitest";
import type { DevWatchInfo, StudioProject } from "../../ipc/bindings";
import {
  asDevWatchList,
  asPluginIdSet,
  asStudioProjectList,
  studioProjectFiles,
  watchingDevItems,
} from "./studioLists";

const watch: DevWatchInfo = {
  project: "demo",
  pluginId: "omni.addon.demo",
  version: "0.1.0",
  dir: "/tmp/demo",
  watching: true,
  enabled: true,
  activated: true,
  lastReloadMs: 1,
  lastError: "",
};

describe("asDevWatchList / watchingDevItems", () => {
  it("keeps the same array reference when the value is already a list", () => {
    const list = [watch];
    expect(asDevWatchList(list)).toBe(list);
  });

  it("does not throw when plugin_dev_status soft-degrades to {} / null / undefined", () => {
    for (const value of [{}, null, undefined, "nope", 0, { watching: true }]) {
      expect(() => watchingDevItems(value)).not.toThrow();
      expect(watchingDevItems(value)).toEqual([]);
    }
  });

  it("filters watching entries from a real list (the StudioPanel headerTags path)", () => {
    const idle = { ...watch, pluginId: "omni.addon.idle", watching: false };
    expect(watchingDevItems([idle, watch]).map((item) => item.pluginId)).toEqual([
      "omni.addon.demo",
    ]);
  });
});

describe("asStudioProjectList / studioProjectFiles", () => {
  const project: StudioProject = {
    name: "demo",
    files: ["plugin.json", "ui/main.js"],
    hasManifest: true,
    location: "user",
    kind: "addon",
    version: "0.1.0",
    displayName: "Demo",
    pluginId: "omni.addon.demo",
  };

  it("returns [] for non-arrays and skips non-objects", () => {
    expect(asStudioProjectList({})).toEqual([]);
    expect(asStudioProjectList(null)).toEqual([]);
    expect(asStudioProjectList([1, "x"])).toEqual([]);
  });

  it("coerces a missing files field so .some / .map / .length do not throw", () => {
    const list = asStudioProjectList([{ name: "bare", hasManifest: false, location: "user" }]);
    expect(list).toHaveLength(1);
    expect(studioProjectFiles(list[0]).some((rel) => rel.endsWith(".wat"))).toBe(false);
    expect(studioProjectFiles(undefined).map((rel) => rel)).toEqual([]);
    expect(studioProjectFiles({ files: {} })).toEqual([]);
  });

  it("preserves a valid project's files", () => {
    const list = asStudioProjectList([project]);
    expect(studioProjectFiles(list[0])).toEqual(["plugin.json", "ui/main.js"]);
  });
});

describe("asPluginIdSet", () => {
  it("ignores non-arrays and items without id", () => {
    expect([...asPluginIdSet({})]).toEqual([]);
    expect([...asPluginIdSet([{ id: "a" }, { id: "" }, {}])]).toEqual(["a"]);
  });
});
