import { describe, expect, it } from "vitest";
import type { PluginListItem } from "../ipc/bindings";
import {
  findImporter,
  importerEntries,
  listActiveImporters,
  secretKeyFor,
} from "./importerCatalog";

function item(id: string, enabled = true, activated = true): PluginListItem {
  return {
    id,
    version: "0.2.0",
    kind: "importer",
    enabled,
    activated,
    source: "builtin",
  };
}

describe("importerCatalog", () => {
  it("从清单读 importer 贡献，不依赖插件 activate", () => {
    const found = findImporter("omni.importer.warpgate", "warpgate");
    expect(found?.pluginId).toBe("omni.importer.warpgate");
    expect(found?.importer.fetchMethod).toBe("fetchTargets");
    expect(found?.importer.fields.some((field) => field.key === "baseUrl")).toBe(true);
    expect(importerEntries(found!.importer)).toEqual(["commandPalette", "settings", "home"]);
  });

  it("仅已启用且已激活的插件出现在活动列表", () => {
    expect(listActiveImporters([item("omni.importer.warpgate", false, true)])).toEqual([]);
    expect(listActiveImporters([item("omni.importer.warpgate", true, false)])).toEqual([]);
    const active = listActiveImporters([item("omni.importer.warpgate")]);
    expect(active).toHaveLength(1);
    expect(active[0]?.importer.id).toBe("warpgate");
  });

  it("secret key 使用清单前缀", () => {
    const found = findImporter("omni.importer.warpgate", "warpgate");
    const token = found?.importer.fields.find((field) => field.key === "token");
    const password = found?.importer.fields.find((field) => field.key === "password");
    expect(token && secretKeyFor(token, "abc")).toBe("src-abc");
    expect(password && secretKeyFor(password, "abc")).toBe("login-abc");
  });
});
