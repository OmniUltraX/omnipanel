import { describe, expect, it } from "vitest";
import type { PluginListItem } from "../../ipc/bindings";
import { originForInstalled, isDbxOrigin, originMetaLabel } from "./pluginOrigin";

function item(partial: Partial<PluginListItem> & Pick<PluginListItem, "id" | "source">): PluginListItem {
  return {
    version: "0.1.0",
    kind: "addon",
    enabled: true,
    activated: true,
    unsupportedReason: null,
    ...partial,
  };
}

describe("originForInstalled", () => {
  it("marks builtin as official", () => {
    expect(
      originForInstalled(item({ id: "omni.engine.mysql", source: "builtin", kind: "engine" }), new Set(), new Set()),
    ).toBe("official");
  });

  it("marks official catalog hits as official", () => {
    expect(
      originForInstalled(
        item({ id: "omni.extra.foo", source: "installed" }),
        new Set(["omni.extra.foo"]),
        new Set(),
      ),
    ).toBe("official");
  });

  it("marks DBX engines as third-party", () => {
    expect(
      originForInstalled(
        item({ id: "omni.engine.dameng", source: "installed", kind: "engine" }),
        new Set(),
        new Set(["omni.engine.dameng"]),
      ),
    ).toBe("thirdParty");
  });

  it("marks unknown disk installs as local", () => {
    expect(
      originForInstalled(item({ id: "community.theme.dark", source: "installed", kind: "theme" }), new Set(), new Set()),
    ).toBe("local");
  });
});

describe("isDbxOrigin", () => {
  it("treats third-party as DBX", () => {
    expect(isDbxOrigin("thirdParty")).toBe(true);
    expect(isDbxOrigin("official")).toBe(false);
    expect(isDbxOrigin("local")).toBe(false);
  });
});

describe("originMetaLabel", () => {
  const t = (key: string) =>
    ({
      "plugins.center.origin.official": "官方",
      "plugins.center.origin.thirdParty": "第三方",
      "plugins.center.origin.local": "本地",
      "plugins.center.origin.dbx": "DBX",
    })[key] ?? key;

  it("appends DBX to third-party labels", () => {
    expect(originMetaLabel("thirdParty", t)).toBe("第三方 · DBX");
  });

  it("leaves official and local unchanged", () => {
    expect(originMetaLabel("official", t)).toBe("官方");
    expect(originMetaLabel("local", t)).toBe("本地");
  });
});
